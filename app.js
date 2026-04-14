(function () {
  "use strict";

  const config = {
    runtimeRegistryUrl:
      (window.AINORMACS_CONFIG && window.AINORMACS_CONFIG.runtimeRegistryUrl) || "",
    registryPollIntervalMs:
      (window.AINORMACS_CONFIG && window.AINORMACS_CONFIG.registryPollIntervalMs) || 30000,
    registryDefaultTtlSec:
      (window.AINORMACS_CONFIG && window.AINORMACS_CONFIG.registryDefaultTtlSec) || 90,
    pollIntervalMs: 2500,
  };

  const statusMap = {
    idle: "Ожидание вопроса.",
    creating: "Создание задачи.",
    queued: "В очереди.",
    running: "Выполняется.",
    done: "Выполнено.",
    failed: "Ошибка.",
    cancelled: "Остановлено.",
    stopping: "Останавливается.",
    unknown: "В обработке.",
  };

  const elements = {
    authPanel: document.getElementById("authPanel"),
    chatPanel: document.getElementById("chatPanel"),
    loginForm: document.getElementById("loginForm"),
    loginButton: document.getElementById("loginButton"),
    loginInput: document.getElementById("loginInput"),
    passwordInput: document.getElementById("passwordInput"),
    authNote: document.getElementById("authNote"),
    logoutButton: document.getElementById("logoutButton"),
    chatBody: document.getElementById("chatBody"),
    chatForm: document.getElementById("chatForm"),
    questionInput: document.getElementById("questionInput"),
    sendButton: document.getElementById("sendButton"),
    taskStatus: document.getElementById("taskStatus"),
    systemStatus: document.getElementById("systemStatus"),
    cancelTaskButton: document.getElementById("cancelTaskButton"),
    queueRunning: document.getElementById("queueRunning"),
    queueWaiting: document.getElementById("queueWaiting"),
    queuePosition: document.getElementById("queuePosition"),
  };

  const state = {
    token: "",
    currentTaskId: "",
    pollTimer: null,
    registryTimer: null,
    apiBase: "",
    apiOnline: false,
    taskBusy: false,
    registryUpdatedAt: "",
    registryTtlSec: config.registryDefaultTtlSec,
    runningDotsTimer: null,
    runningDotsValue: 0,
    pollErrorStreak: 0,
  };

  function escapeHtml(raw) {
    return String(raw)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function renderMessageText(raw) {
    return escapeHtml(raw).replace(/\n/g, "<br>");
  }

  function formatAgentAnswer(rawAnswer) {
    let text = String(rawAnswer || "").replace(/\r\n/g, "\n").trim();
    if (!text) return "Ответ получен.";

    // Normalize Telegram-style separators and labels for web chat.
    text = text.replace(/_{4,}/g, "\n");
    text = text.replace(/\s*ИСТОЧНИКИ\s+И\s+ЦИТАТЫ\s*:\s*/giu, "\n\nИсточники:\n");
    text = text.replace(
      /\s*ПРОАНАЛИЗИРОВАННЫЕ\s+ДОКУМЕНТЫ\s*:\s*/giu,
      "\n\nПроанализированные документы:\n"
    );
    text = text.replace(/(Источники:\s*)(\d+\.\s)/g, "$1\n$2");
    text = text.replace(/(Проанализированные документы:\s*)(\d+\.\s)/g, "$1\n$2");
    text = text.replace(/\n[ \t]+/g, "\n");
    text = text.replace(/[ \t]+\n/g, "\n");
    text = text.replace(/\n{3,}/g, "\n\n");
    return text.trim();
  }

  function appendMessage(role, author, text) {
    const article = document.createElement("article");
    article.className = `msg ${role}`;
    article.innerHTML =
      `<p class="author">${escapeHtml(author)}</p>` +
      `<p>${renderMessageText(text)}</p>`;
    elements.chatBody.appendChild(article);
    elements.chatBody.scrollTop = elements.chatBody.scrollHeight;
  }

  function setAuthorized(authorized) {
    elements.authPanel.classList.toggle("hidden", authorized);
    elements.chatPanel.classList.toggle("hidden", !authorized);
  }

  function statusLabel(rawStatus) {
    const key = String(rawStatus || "unknown").toLowerCase();
    return statusMap[key] || statusMap.unknown;
  }

  function stopRunningDots() {
    if (state.runningDotsTimer) {
      clearInterval(state.runningDotsTimer);
      state.runningDotsTimer = null;
    }
    state.runningDotsValue = 0;
  }

  function startRunningDots() {
    stopRunningDots();
    state.runningDotsValue = 1;
    elements.taskStatus.textContent = `Статус задачи: Выполняется${".".repeat(state.runningDotsValue)}`;
    state.runningDotsTimer = setInterval(function () {
      state.runningDotsValue = (state.runningDotsValue % 3) + 1;
      elements.taskStatus.textContent = `Статус задачи: Выполняется${".".repeat(state.runningDotsValue)}`;
    }, 450);
  }

  function setTaskStatus(rawStatus) {
    const key = String(rawStatus || "unknown").toLowerCase();
    if (key === "running") {
      startRunningDots();
      return;
    }
    stopRunningDots();
    elements.taskStatus.textContent = `Статус задачи: ${statusLabel(key)}`;
  }

  function setTaskStatusText(text) {
    stopRunningDots();
    elements.taskStatus.textContent = `Статус задачи: ${text}`;
  }

  function setSystemStatusText(text) {
    if (!elements.systemStatus) return;
    elements.systemStatus.textContent = `Система: ${text}`;
  }

  function updateQueueCounters(running, waiting, position) {
    elements.queueRunning.textContent = `${running} выполняется`;
    elements.queueWaiting.textContent = `${waiting} ожидают`;
    elements.queuePosition.textContent = position > 0 ? `Позиция: ${position}` : "Позиция: -";
  }

  function clearPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function refreshControls() {
    const questionDisabled = state.taskBusy || !state.apiOnline;
    elements.sendButton.disabled = questionDisabled;
    elements.questionInput.disabled = questionDisabled;
    elements.cancelTaskButton.classList.toggle("hidden", !state.taskBusy);
    elements.loginButton.disabled = !state.apiOnline;
  }

  function setBusy(busy) {
    state.taskBusy = busy;
    if (!busy) {
      state.currentTaskId = "";
      clearPolling();
      stopRunningDots();
    }
    refreshControls();
  }

  function parseRegistryTimestamp(value) {
    const ms = Date.parse(String(value || ""));
    return Number.isFinite(ms) ? ms : 0;
  }

  function registryIsFresh(updatedAt, ttlSec) {
    const updatedMs = parseRegistryTimestamp(updatedAt);
    if (!updatedMs) return false;
    return Date.now() - updatedMs <= ttlSec * 1000;
  }

  function updateAvailabilityUi() {
    if (state.apiOnline) {
      if (!state.token && !elements.authNote.classList.contains("error")) {
        elements.authNote.textContent = "Сервер подключен. Можно авторизоваться.";
      }
      setSystemStatusText("Соединение с backend стабильно.");
      if (!state.taskBusy && !state.currentTaskId) {
        setTaskStatus("idle");
      }
    } else {
      elements.authNote.classList.remove("error");
      elements.authNote.textContent = "Сервер сейчас недоступен. Сообщите разрабочику, что упал бекэнд.";
      setSystemStatusText("Соединение с backend потеряно. Ожидаю восстановление.");
    }
    refreshControls();
  }

  async function loadRuntimeConfig(options) {
    const silent = options && options.silent;

    if (!config.runtimeRegistryUrl) {
      state.apiBase = "";
      state.apiOnline = false;
      state.registryUpdatedAt = "";
      state.registryTtlSec = config.registryDefaultTtlSec;
      updateAvailabilityUi();
      if (!silent) {
        throw new Error("Не настроен адрес runtime-конфига.");
      }
      return { changed: false, online: false };
    }

    const url =
      `${config.runtimeRegistryUrl}` +
      `${config.runtimeRegistryUrl.includes("?") ? "&" : "?"}ts=${Date.now()}`;

    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      });
    } catch (error) {
      if (!silent) {
        throw new Error("Не удалось загрузить runtime-конфиг.");
      }
      return { changed: false, online: state.apiOnline };
    }

    if (!response.ok) {
      if (!silent) {
        throw new Error(`Runtime-конфиг недоступен: HTTP ${response.status}`);
      }
      return { changed: false, online: state.apiOnline };
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (!silent) {
        throw new Error("Runtime-конфиг поврежден.");
      }
      return { changed: false, online: state.apiOnline };
    }

    const ttlSec = Math.max(
      30,
      Number(payload && payload.ttlSec ? payload.ttlSec : config.registryDefaultTtlSec) || config.registryDefaultTtlSec
    );
    const updatedAt = String(payload && payload.updatedAt ? payload.updatedAt : "");
    const apiBase = String(payload && payload.apiBase ? payload.apiBase : "").trim();
    const online = Boolean(payload && payload.online) && registryIsFresh(updatedAt, ttlSec) && Boolean(apiBase);
    const nextApiBase = online ? apiBase : "";
    const changed = state.apiBase !== nextApiBase || state.apiOnline !== online;

    state.apiBase = nextApiBase;
    state.apiOnline = online;
    state.registryUpdatedAt = updatedAt;
    state.registryTtlSec = ttlSec;
    updateAvailabilityUi();

    return {
      changed,
      online,
      apiBase: nextApiBase,
    };
  }

  async function ensureApiOnline() {
    if (state.apiOnline && state.apiBase) {
      return true;
    }
    await loadRuntimeConfig({ silent: false });
    if (!state.apiOnline || !state.apiBase) {
      throw new Error("Сервис сейчас недоступен. Сообщите разрабочику, что упал бекэнд.");
    }
    return true;
  }

  async function apiFetch(path, options, attempt) {
    const currentAttempt = Number(attempt || 0);
    await ensureApiOnline();

    const headers = Object.assign(
      {
        "Content-Type": "application/json",
      },
      options && options.headers ? options.headers : {}
    );
    if (state.token) {
      headers.Authorization = `Bearer ${state.token}`;
    }

    const url = `${state.apiBase}${path}`;
    let response;
    try {
      response = await fetch(url, Object.assign({}, options || {}, { headers, cache: "no-store" }));
    } catch (error) {
      const previousApiBase = state.apiBase;
      await loadRuntimeConfig({ silent: true });
      if (currentAttempt === 0 && state.apiOnline && state.apiBase && state.apiBase !== previousApiBase) {
        return apiFetch(path, options, currentAttempt + 1);
      }
      throw new Error("Не удалось подключиться к backend.");
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const previousApiBase = state.apiBase;
      await loadRuntimeConfig({ silent: true });
      if (currentAttempt === 0 && state.apiOnline && state.apiBase && state.apiBase !== previousApiBase) {
        return apiFetch(path, options, currentAttempt + 1);
      }
      const message = payload && payload.detail ? String(payload.detail) : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload;
  }

  async function submitLogin() {
    elements.authNote.classList.remove("error");
    elements.authNote.textContent = "";
    elements.loginButton.disabled = true;

    try {
      const result = await apiFetch("/api/login", {
        method: "POST",
        body: JSON.stringify({
          login: elements.loginInput.value.trim(),
          password: elements.passwordInput.value,
        }),
      });
      if (!result.token) {
        throw new Error("Сервер не вернул токен.");
      }
      state.token = result.token;
      setAuthorized(true);
      elements.chatBody.innerHTML = "";
      appendMessage("agent", "AI NormaCS", "Авторизация успешна. Можете задать вопрос.");
      setTaskStatus("idle");
    } catch (error) {
      elements.authNote.classList.add("error");
      elements.authNote.textContent = error.message || "Ошибка авторизации.";
    } finally {
      refreshControls();
    }
  }

  async function pollTask() {
    if (!state.currentTaskId) return;
    try {
      const result = await apiFetch(`/api/tasks/${encodeURIComponent(state.currentTaskId)}`, {
        method: "GET",
      });
      state.pollErrorStreak = 0;

      const status = String(result.status || "unknown").toLowerCase();
      const position = Number(result.queue_position || 0);
      const running = status === "running" ? 1 : 0;
      const waiting = status === "queued" ? Math.max(position - 1, 0) : 0;

      updateQueueCounters(running, waiting, position);
      setTaskStatus(status);

      if (status === "done") {
        appendMessage("agent", "AI NormaCS", formatAgentAnswer(String(result.answer || "Ответ получен.")));
        setBusy(false);
      } else if (status === "failed") {
        appendMessage("agent", "AI NormaCS", `Ошибка: ${String(result.error || "неизвестно")}`);
        setBusy(false);
      } else if (status === "cancelled") {
        appendMessage("agent", "AI NormaCS", "Задача остановлена.");
        setBusy(false);
      }
    } catch (error) {
      state.pollErrorStreak += 1;
      const message = String(error && error.message ? error.message : "Ошибка связи");
      if (message.toLowerCase().includes("invalid or expired token")) {
        setTaskStatusText("Сессия истекла. Авторизуйтесь снова.");
        setBusy(false);
        return;
      }
      setSystemStatusText(
        `Проблема связи с backend. Повторяю попытку (${state.pollErrorStreak}).`
      );
    }
  }

  async function startTask(question) {
    setBusy(true);
    setTaskStatus("creating");
    try {
      const result = await apiFetch("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ question }),
      });
      if (!result.task_id) {
        throw new Error("Сервер не вернул task_id.");
      }
      state.currentTaskId = String(result.task_id);
      setTaskStatusText("Задача принята. Отслеживаю статус.");
      clearPolling();
      state.pollTimer = setInterval(pollTask, config.pollIntervalMs);
      await pollTask();
    } catch (error) {
      setTaskStatusText(`Ошибка запуска: ${error.message}`);
      setBusy(false);
    }
  }

  async function cancelTask() {
    if (!state.currentTaskId) return;
    try {
      await apiFetch(`/api/tasks/${encodeURIComponent(state.currentTaskId)}/cancel`, {
        method: "POST",
      });
      setTaskStatus("stopping");
      setTaskStatusText("Отправлена команда остановки задачи.");
    } catch (error) {
      setTaskStatusText(`Не удалось остановить задачу: ${error.message}`);
    }
  }

  function logout() {
    clearPolling();
    state.token = "";
    state.currentTaskId = "";
    elements.chatBody.innerHTML = "";
    updateQueueCounters(0, 0, 0);
    setBusy(false);
    elements.passwordInput.value = "";
    elements.loginInput.value = "";
    elements.authNote.textContent = "";
    elements.authNote.classList.remove("error");
    setAuthorized(false);
    setSystemStatusText("Ожидание авторизации.");
    updateAvailabilityUi();
  }

  async function refreshRuntimeConfigSilently() {
    try {
      const result = await loadRuntimeConfig({ silent: true });
      if (result.changed && state.token && state.apiOnline) {
        setSystemStatusText("Подключение к backend обновлено.");
      }
    } catch (error) {
      // ignore background refresh failures
    }
  }

  elements.loginForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    await submitLogin();
  });

  elements.chatForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    const question = elements.questionInput.value.trim();
    if (!question) return;
    elements.questionInput.value = "";
    appendMessage("user", "Пользователь", question);
    await startTask(question);
  });

  elements.cancelTaskButton.addEventListener("click", cancelTask);
  elements.logoutButton.addEventListener("click", logout);

  setAuthorized(false);
  updateQueueCounters(0, 0, 0);
  setBusy(false);
  setSystemStatusText("Ожидание подключения.");
  loadRuntimeConfig({ silent: true }).finally(function () {
    updateAvailabilityUi();
  });
  state.registryTimer = setInterval(refreshRuntimeConfigSilently, config.registryPollIntervalMs);
})();

