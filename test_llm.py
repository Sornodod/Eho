from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:1234/v1",
    api_key="lm-studio",
    timeout=120,
)

print("=== CHAT ===")
response = client.chat.completions.create(
    model="qwen/qwen3.6-27b",
    messages=[
        {
            "role": "system",
            "content": "Ты локальный агент диагностики ИТ-инфраструктуры.",
        },
        {
            "role": "user",
            "content": "Ответь кратко по-русски: подключение работает.",
        },
    ],
    temperature=0,
    max_tokens=100,
)
print(response.choices[0].message.content)

print("\n=== EMBEDDINGS ===")
result = client.embeddings.create(
    model="text-embedding-nomic-embed-text-v1.5",
    input=["ошибка VMware", "проблема виртуальной машины"],
)
print("Количество векторов:", len(result.data))
print("Размерность вектора:", len(result.data[0].embedding))
