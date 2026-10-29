
import argparse
import re
import sqlite3
from pathlib import Path

import numpy as np
from openai import OpenAI

from app.rag.vault_db import get_vault_db, validate_vault

API_URL = "http://127.0.0.1:1234/v1"
EMBED_MODEL = "text-embedding-nomic-embed-text-v1.5"
RRF_K = 60
CANDIDATES = 100

client = OpenAI(base_url=API_URL, api_key="lm-studio")


def embed_query(query: str) -> np.ndarray:
    response = client.embeddings.create(
        model=EMBED_MODEL,
        input=[f"search_query: {query}"],
    )
    return np.asarray(response.data[0].embedding, dtype=np.float32)


def vector_search(query_vector: np.ndarray, rows: list) -> list:
    query_norm = np.linalg.norm(query_vector)
    results = []

    for path, ordinal, heading, content, blob, dimensions in rows:
        if blob is None:
            continue

        vector = np.frombuffer(blob, dtype=np.float32)

        if len(vector) != dimensions or len(vector) != len(query_vector):
            continue

        norm = np.linalg.norm(vector)
        if norm == 0 or query_norm == 0:
            continue

        score = float(np.dot(query_vector, vector) / (query_norm * norm))
        results.append({
            "key": (path, ordinal),
            "path": path,
            "ordinal": ordinal,
            "heading": heading,
            "content": content,
            "vector_score": score,
        })

    results.sort(key=lambda item: item["vector_score"], reverse=True)
    return results[:CANDIDATES]


def fulltext_search(query: str, rows: list) -> list:
    tokens = list(dict.fromkeys(re.findall(r"\w+", query, flags=re.UNICODE)))
    if not tokens:
        return []

    match_query = " OR ".join(
        '"' + token.replace('"', '""') + '"' for token in tokens
    )

    with sqlite3.connect(":memory:") as con:
        con.execute("""
            CREATE VIRTUAL TABLE fts USING fts5(
                path UNINDEXED,
                ordinal UNINDEXED,
                heading,
                content,
                tokenize='unicode61'
            )
        """)

        con.executemany(
            "INSERT INTO fts(path, ordinal, heading, content) VALUES (?, ?, ?, ?)",
            [
                (path, ordinal, heading or "", content or "")
                for path, ordinal, heading, content, *_ in rows
            ],
        )

        matches = con.execute("""
            SELECT path, ordinal, heading, content, bm25(fts) AS score
            FROM fts
            WHERE fts MATCH ?
            ORDER BY score
            LIMIT ?
        """, (match_query, CANDIDATES)).fetchall()

    return [
        {
            "key": (path, ordinal),
            "path": path,
            "ordinal": ordinal,
            "heading": heading,
            "content": content,
            "fts_score": float(score),
        }
        for path, ordinal, heading, content, score in matches
    ]


def search(
    query: str,
    limit: int = 5,
    vault_path: str | None = None,
) -> list[dict]:
    query = query.strip()
    if not query:
        raise ValueError("Поисковый запрос пуст")

    if not vault_path:
        raise ValueError("Не передан путь к Obsidian-хранилищу")

    vault = validate_vault(vault_path)
    db = get_vault_db(str(vault))

    if not db.exists():
        raise FileNotFoundError(
            f"Индекс этого хранилища не найден: {db}. "
            f"Сначала выполните индексацию: "
            f"python -m app.rag.indexer \"{vault}\""
        )

    with sqlite3.connect(db) as con:
        rows = con.execute("""
            SELECT path, ordinal, heading, content, embedding, dimensions
            FROM chunks
        """).fetchall()

    if not rows:
        return []

    query_vector = embed_query(query)
    vectors = vector_search(query_vector, rows)
    texts = fulltext_search(query, rows)
    combined = {}

    for rank, item in enumerate(vectors, start=1):
        key = item["key"]
        combined[key] = item.copy()
        combined[key]["vector_rank"] = rank
        combined[key]["rrf"] = 1 / (RRF_K + rank)

    for rank, item in enumerate(texts, start=1):
        key = item["key"]
        if key not in combined:
            combined[key] = item.copy()
            combined[key]["vector_rank"] = None
            combined[key]["rrf"] = 0

        combined[key]["fts_rank"] = rank
        combined[key]["rrf"] += 1 / (RRF_K + rank)

    results = sorted(
        combined.values(),
        key=lambda item: item["rrf"],
        reverse=True,
    )

    return [
        {
            "rank": rank,
            "path": item["path"],
            "ordinal": item["ordinal"],
            "heading": item.get("heading") or "",
            "content": item["content"].strip(),
            "rrf": item["rrf"],
            "vector_rank": item.get("vector_rank"),
            "vector_score": item.get("vector_score"),
            "fts_rank": item.get("fts_rank"),
        }
        for rank, item in enumerate(results[:max(1, limit)], start=1)
    ]


def print_results(query: str, results: list[dict]) -> None:
    print(f"\nНайдено фрагментов: {len(results)}")
    print(f"Запрос: {query}")
    print("Метод: векторный поиск + FTS5 + RRF\n")

    for item in results:
        print("=" * 80)
        print(f"{item['rank']}. RRF: {item['rrf']:.5f}")

        if item["vector_rank"] is not None:
            score = item["vector_score"] or 0
            print(f"Векторный ранг: {item['vector_rank']}, cosine: {score:.4f}")
        else:
            print("Векторный ранг: нет")

        print(f"Полнотекстовый ранг: {item['fts_rank'] or 'нет'}")
        print(f"Файл: {item['path']}")
        print(f"Фрагмент: {item['ordinal']}")

        if item["heading"]:
            print(f"Заголовок: {item['heading']}")

        print()
        print(item["content"])
        print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Гибридный поиск по базе знаний Eho"
    )
    parser.add_argument("query", help="Поисковый запрос")
    parser.add_argument("-n", "--limit", type=int, default=5)
    parser.add_argument(
        "--vault",
        required=True,
        help="Путь к Obsidian-хранилищу",
    )

    args = parser.parse_args()
    print_results(
        args.query,
        search(args.query, args.limit, args.vault),
    )
