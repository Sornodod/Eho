
const {
  Plugin,
  ItemView,
  Notice,
  MarkdownRenderer,
  PluginSettingTab,
  Setting
} = require("obsidian");

const { spawn } = require("child_process");
const fs = require("fs");

const EHO_DIR = "/home/sorn/SOFT/Projects/Eho";
const PYTHON = `${EHO_DIR}/.venv/bin/python`;

const VIEW_TYPE = "eho-search-view";
const API_URL = "http://127.0.0.1:8765";

const DEFAULT_SETTINGS = {
  provider: "lmstudio",
  llmBaseUrl: "http://127.0.0.1:1234/v1",
  llmModel: "google/gemma-4-e4b",
  llmApiKey: "",
  viewMode: "sidebar"
};

const PROVIDERS = {
  lmstudio: {
    name: "LM Studio",
    url: "http://127.0.0.1:1234/v1",
    key: "",
    model: "google/gemma-4-e4b"
  },
  ollama: {
    name: "Ollama (OpenAI-compatible)",
    url: "http://127.0.0.1:11434/v1",
    key: "ollama",
    model: ""
  },
  openai: {
    name: "OpenAI",
    url: "https://api.openai.com/v1",
    key: "",
    model: "gpt-4.1-mini"
  },
  openrouter: {
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1",
    key: "",
    model: ""
  },
  custom: {
    name: "Другой OpenAI-совместимый API",
    url: "",
    key: "",
    model: ""
  }
};

class EhoSearchView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Eho: поиск инструкций";
  }

  getIcon() {
    return "search";
  }

  getVaultPath() {
    const adapter = this.app.vault.adapter;

    if (typeof adapter.getBasePath !== "function") {
      throw new Error(
        "Не удалось получить путь к активному Obsidian-хранилищу."
      );
    }

    return adapter.getBasePath();
  }

  async onOpen() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("eho-search-view");

    root.createEl("h3", { text: "Eho: поиск инструкций" });
    root.createEl("p", {
      text: "Вставь текст заявки или опиши проблему."
    });

    root.createEl("small", {
      text: `Хранилище: ${this.getVaultPath()}`
    });

    const input = root.createEl("textarea", {
      cls: "eho-search-input",
      attr: {
        placeholder: "Текст заявки, ошибка, симптомы...",
        rows: "6"
      }
    });

    const button = root.createEl("button", {
      text: "Найти инструкции",
      cls: "mod-cta"
    });

    const analyzeButton = root.createEl("button", {
      text: "Разобрать заявку",
      cls: "mod-cta"
    });

    const apiButton = root.createEl("button", {
      text: "Запустить API"
    });

    const status = root.createEl("p", {
      cls: "eho-search-status"
    });

    const analysis = root.createDiv({
      cls: "eho-analysis"
    });

    const results = root.createDiv({
      cls: "eho-search-results"
    });

    apiButton.addEventListener("click", async () => {
      apiButton.disabled = true;
      let logFd;

      try {
        status.setText("Проверяю состояние Eho API...");

        try {
          const response = await fetch(`${API_URL}/api/health`);

          if (response.ok) {
            status.setText("Eho API уже запущен.");
            new Notice("Eho API уже работает.");
            return;
          }
        } catch (_) {
          // API недоступен. Пробуем запустить.
        }

        fs.mkdirSync(`${EHO_DIR}/logs`, {
          recursive: true
        });

        logFd = fs.openSync(
          `${EHO_DIR}/logs/api.log`,
          "a"
        );

        let spawnError = null;

        const child = spawn(
          PYTHON,
          [
            "-m",
            "uvicorn",
            "app.api.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            "8765"
          ],
          {
            cwd: EHO_DIR,
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env: process.env
          }
        );

        child.on("error", error => {
          spawnError = error;
        });

        child.unref();

        fs.closeSync(logFd);
        logFd = undefined;

        status.setText("Запускаю API...");
        let started = false;

        for (let i = 0; i < 20; i++) {
          await new Promise(resolve =>
            setTimeout(resolve, 500)
          );

          if (spawnError) {
            throw spawnError;
          }

          try {
            const response = await fetch(
              `${API_URL}/api/health`
            );

            if (response.ok) {
              started = true;
              break;
            }
          } catch (_) {
            // Сервер ещё запускается.
          }
        }

        if (!started) {
          throw new Error(
            "API не ответил за 10 секунд. Проверь logs/api.log"
          );
        }

        status.setText("Eho API запущен и доступен.");
        new Notice("Eho API запущен.");
      } catch (error) {
        console.error("Eho API startup error:", error);
        status.setText(`Ошибка запуска API: ${error.message}`);
        new Notice("Не удалось запустить Eho API. Проверь журнал.");
      } finally {
        if (logFd !== undefined) {
          try {
            fs.closeSync(logFd);
          } catch (_) {}
        }

        apiButton.disabled = false;
      }
    });

    analyzeButton.addEventListener("click", async () => {
      const query = input.value.trim();

      if (!query) {
        new Notice("Сначала вставь текст заявки.");
        return;
      }

      analyzeButton.disabled = true;
      analysis.empty();
      status.setText("Анализирую заявку через выбранную модель...");

      try {
        const settings = this.plugin.settings;
        const vault_path = this.getVaultPath();

        if (!settings.llmBaseUrl.trim()) {
          throw new Error("Не задан URL API в настройках Eho.");
        }

        if (!settings.llmModel.trim()) {
          throw new Error("Не задана модель в настройках Eho.");
        }

        const response = await fetch(`${API_URL}/api/analyze`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            query,
            vault_path,
            limit: 6,
            llm_base_url: settings.llmBaseUrl.trim(),
            llm_model: settings.llmModel.trim(),
            llm_api_key: settings.llmApiKey
          })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.detail || `HTTP ${response.status}`
          );
        }

        status.setText("Анализ завершён");

        analysis.createEl("h3", {
          text: "Рекомендации Eho"
        });

        const answerEl = analysis.createDiv({
          cls: "eho-analysis-answer markdown-rendered"
        });

        await MarkdownRenderer.render(
          this.app,
          data.answer,
          answerEl,
          "",
          this
        );

        if (data.sources && data.sources.length) {
          analysis.createEl("h4", {
            text: "Источники"
          });

          for (const source of data.sources) {
            const row = analysis.createDiv({
              cls: "eho-source"
            });

            row.createEl("div", {
              text: source.path
            });

            if (source.heading) {
              row.createEl("small", {
                text: source.heading
              });
            }

            const openContainer = row.createEl("div");
            const open = openContainer.createEl("button", {
              text: "Открыть заметку"
            });

            open.addEventListener("click", async () => {
              await this.app.workspace.openLinkText(
                source.path,
                "",
                false
              );
            });
          }
        }
      } catch (error) {
        console.error("Eho analysis error:", error);
        status.setText(`Ошибка анализа: ${error.message}`);
        new Notice(
          "Не удалось разобрать заявку. Проверь настройки и API."
        );
      } finally {
        analyzeButton.disabled = false;
      }
    });

    button.addEventListener("click", async () => {
      const query = input.value.trim();

      if (!query) {
        new Notice("Сначала вставь текст заявки.");
        return;
      }

      button.disabled = true;
      status.setText("Ищу в базе знаний...");
      results.empty();

      try {
        const response = await fetch(`${API_URL}/api/search`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            query,
            vault_path: this.getVaultPath(),
            limit: 10
          })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.detail || `HTTP ${response.status}`
          );
        }

        status.setText(
          `Найдено фрагментов: ${data.count}`
        );

        for (const item of data.results) {
          const card = results.createDiv({
            cls: "eho-result"
          });

          card.createEl("strong", {
            text: `${item.rank}. ${
              item.heading || item.path.split("/").pop()
            }`
          });

          card.createEl("div", {
            cls: "eho-result-path",
            text: item.path
          });

          card.createEl("p", {
            text: item.content
          });

          const open = card.createEl("button", {
            text: "Открыть заметку"
          });

          open.addEventListener("click", async () => {
            await this.app.workspace.openLinkText(
              item.path,
              "",
              false
            );
          });
        }

        if (!data.results.length) {
          results.createEl("p", {
            text: "Ничего не найдено."
          });
        }
      } catch (error) {
        console.error("Eho search error:", error);
        status.setText(`Ошибка: ${error.message}`);
        new Notice(
          "Поиск не удался. Проверь API и индекс хранилища."
        );
      } finally {
        button.disabled = false;
      }
    });

    input.addEventListener("keydown", event => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key === "Enter"
      ) {
        button.click();
      }
    });
  }
}

class EhoSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", {
      text: "Eho: настройки ИИ"
    });

    containerEl.createEl("p", {
      text:
        "Настройки чат-модели. Поиск по базе знаний пока использует " +
        "отдельную модель эмбеддингов LM Studio."
    });

    new Setting(containerEl)
      .setName("Расположение Eho")
      .setDesc("Открывать поиск в боковой панели или отдельной вкладке.")
      .addDropdown(dropdown => dropdown
        .addOption("sidebar", "Боковая панель")
        .addOption("tab", "Новая вкладка")
        .setValue(this.plugin.settings.viewMode || "sidebar")
        .onChange(async value => {
          this.plugin.settings.viewMode = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Провайдер")
      .setDesc("Выбери готовый профиль или укажи собственный API.")
      .addDropdown(dropdown => {
        dropdown
          .addOption("lmstudio", "LM Studio")
          .addOption("ollama", "Ollama (OpenAI-compatible)")
          .addOption("openai", "OpenAI")
          .addOption("openrouter", "OpenRouter")
          .addOption("custom", "Другой OpenAI-совместимый API")
          .setValue(this.plugin.settings.provider)
          .onChange(async value => {
            const preset = PROVIDERS[value];

            this.plugin.settings.provider = value;

            if (preset) {
              this.plugin.settings.llmBaseUrl = preset.url;
              this.plugin.settings.llmModel = preset.model;

              if (value === "lmstudio") {
                this.plugin.settings.llmApiKey = "";
              } else if (value === "ollama") {
                this.plugin.settings.llmApiKey = "ollama";
              } else if (value === "openai" ||
                         value === "openrouter") {
                this.plugin.settings.llmApiKey = "";
              }
            }

            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("URL API")
      .setDesc("Например, http://127.0.0.1:1234/v1")
      .addText(text =>
        text
          .setPlaceholder("https://api.example.com/v1")
          .setValue(this.plugin.settings.llmBaseUrl)
          .onChange(async value => {
            this.plugin.settings.llmBaseUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Название модели")
      .setDesc("Идентификатор модели, поддерживаемый выбранным API.")
      .addText(text =>
        text
          .setPlaceholder("Название модели")
          .setValue(this.plugin.settings.llmModel)
          .onChange(async value => {
            this.plugin.settings.llmModel = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API-ключ")
      .setDesc(
        "Для локальных серверов ключ может не требоваться. " +
        "Ключ хранится в настройках Obsidian без шифрования."
      )
      .addText(text => {
        text
          .setPlaceholder("API-ключ")
          .setValue(this.plugin.settings.llmApiKey)
          .onChange(async value => {
            this.plugin.settings.llmApiKey = value;
            await this.plugin.saveSettings();
          });

        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Проверка API")
      .setDesc("Проверяет соединение и доступность выбранной модели.")
      .addButton(button => {
        button
          .setButtonText("Проверить")
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("Проверка...");

            try {
              const response = await fetch(`${API_URL}/api/provider-check`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  llm_base_url: this.plugin.settings.llmBaseUrl,
                  llm_model: this.plugin.settings.llmModel,
                  llm_api_key: this.plugin.settings.llmApiKey
                })
              });

              const data = await response.json();

              if (!response.ok) {
                throw new Error(
                  data.detail || `HTTP ${response.status}`
                );
              }

              new Notice(
                data.message || "Подключение успешно."
              );
            } catch (error) {
              new Notice(
                `Проверка не удалась: ${error.message}`
              );
            } finally {
              button.setDisabled(false);
              button.setButtonText("Проверить");
            }
          });
      });

    containerEl.createEl("p", {
      text:
        "Важно: запросы к облачному провайдеру передают ему текст заявки " +
        "и найденные фрагменты базы знаний. Не отправляй туда секреты " +
        "или данные, которые запрещено передавать за пределы инфраструктуры."
    });
  }
}

module.exports = class EhoSearchPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE,
      leaf => new EhoSearchView(leaf, this)
    );

    this.addSettingTab(
      new EhoSettingTab(this.app, this)
    );

    this.addRibbonIcon(
      "search",
      "Eho: поиск инструкций",
      () => this.activateView()
    );

    this.addCommand({
      id: "open-search",
      name: "Открыть поиск инструкций Eho",
      callback: () => this.activateView()
    });
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async activateView() {
    const workspace = this.app.workspace;
    const viewMode = this.settings.viewMode || "sidebar";
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];

    if (!leaf) {
      leaf = viewMode === "tab"
        ? workspace.getLeaf("tab")
        : workspace.getRightLeaf(false);

      await leaf.setViewState({
        type: VIEW_TYPE,
        active: true
      });
    }

    workspace.revealLeaf(leaf);
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }
};
