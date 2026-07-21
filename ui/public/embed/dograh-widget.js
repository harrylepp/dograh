/**
 * Dograh Voice and Chat Widget
 * Embeddable voice call widget for Dograh workflows
 * Version: 1.0.0
 */

(function() {
  'use strict';

  // Widget configuration defaults
  const DEFAULT_CONFIG = {
    position: 'bottom-right',
    autoStart: false,
    apiBaseUrl: window.location.hostname === 'localhost'
      ? 'http://localhost:8000'
      : 'https://api.dograh.com'
  };

  // Widget state
  const state = {
    config: {},
    isInitialized: false,
    isOpen: false,
    pc: null,
    ws: null,
    stream: null,
    sessionToken: null,
    workflowRunId: null,
    pcId: null,
    connectionStatus: 'idle', // idle, connecting, connected, failed
    audioElement: null,
    turnCredentials: null, // TURN server credentials
    callStartedAt: null, // Timestamp when call connected (for duration tracking)
    gracefulDisconnect: false,
    // Text-chat state
    mode: 'voice', // 'voice' | 'chat'
    chatSessionToken: null,
    chatRunId: null,
    chatRevision: null,
    chatTurns: [],
    chatStatus: 'idle',
    chatSending: false,
    chatSessionInited: false,
    chatDraft: '',
    chatError: null,
    inlineDisplayText: null,
    inlineDisplaySubtext: null,
    chatCallbacks: {
      onChatMessage: null,
      onChatStatusChange: null
    },
    callbacks: {
      onReady: null,
      onCallStart: null,
      onCallConnected: null,
      onCallDisconnected: null,
      onCallEnd: null,
      onError: null,
      onStatusChange: null
    }
  };

  /**
   * Initialize the widget
   */
  async function init() {
    if (state.isInitialized) return;

    // Get token from script URL
    const script = document.currentScript || document.querySelector('script[src*="dograh-widget.js"]');
    if (!script) {
      console.error('Dograh Widget: Script not found');
      return;
    }

    // Extract parameters from URL
    const scriptUrl = new URL(script.src);
    const token = scriptUrl.searchParams.get('token');
    const apiEndpoint = scriptUrl.searchParams.get('apiEndpoint');
    const environment = scriptUrl.searchParams.get('environment');

    if (!token) {
      console.error('Dograh Widget: No token found in script URL');
      return;
    }

    // Determine API base URL
    let apiBaseUrl = DEFAULT_CONFIG.apiBaseUrl;
    if (apiEndpoint) {
      // Use the apiEndpoint from URL parameter if provided
      // Ensure it has a protocol
      if (!apiEndpoint.startsWith('http://') && !apiEndpoint.startsWith('https://')) {
        // Default to https for production endpoints
        apiBaseUrl = 'https://' + apiEndpoint.replace(/\/+$/, '');
      } else {
        apiBaseUrl = apiEndpoint.replace(/\/+$/, ''); // Remove trailing slashes
      }
    } else if (scriptUrl.origin.includes('localhost')) {
      apiBaseUrl = 'http://localhost:8000';
    } else {
      apiBaseUrl = scriptUrl.origin.replace(/:\d+$/, ':8000');
    }

    // Store base configuration
    state.config = {
      ...DEFAULT_CONFIG,
      token: token,
      apiBaseUrl: apiBaseUrl,
      environment: environment || 'production',
      // Allow data attributes to override fetched config
      contextVariables: parseContextVariables(script.getAttribute('data-dograh-context'))
    };

    try {
      // Fetch configuration from API
      const configResponse = await fetch(`${state.config.apiBaseUrl}/api/v1/public/embed/config/${token}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Origin': window.location.origin
        }
      });

      if (!configResponse.ok) {
        throw new Error(`Failed to fetch config: ${configResponse.status}`);
      }

      const configData = await configResponse.json();

      // Merge fetched configuration with defaults
      state.config = {
        ...state.config,
        workflowId: configData.workflow_id,
        embedMode: configData.settings?.embedMode || 'floating',
        containerId: configData.settings?.containerId || 'dograh-inline-container',
        position: configData.position || DEFAULT_CONFIG.position,
        buttonColor: configData.settings?.buttonColor || '#10b981',
        buttonText: configData.settings?.buttonText || 'Talk to Agent',
        callToActionText: configData.settings?.callToActionText || 'Click to start voice conversation',
        autoStart: configData.auto_start || false,
        modes: parseModes(configData.settings?.modes),
        defaultMode: configData.default_mode || configData.settings?.defaultMode || 'voice'
      };

      // Resolve active mode: honor default if available, otherwise first mode.
      const configuredModes = state.config.modes;
      if (configuredModes.length > 0) {
        state.mode = configuredModes.includes(state.config.defaultMode)
          ? state.config.defaultMode
          : configuredModes[0];
      } else {
        state.mode = 'voice';
      }
      // If only one mode is configured, lock to it.
      if (configuredModes.length === 1) {
        state.mode = configuredModes[0];
      }
    } catch (error) {
      console.error('Dograh Widget: Failed to fetch configuration', error);
      return;
    }

    state.isInitialized = true;

    // Create widget UI based on mode
    if (state.config.embedMode === 'inline') {
      injectStyles();
      createInlineWidget();
    } else if (state.config.embedMode === 'headless') {
      createHeadlessWidget();
    } else {
      injectStyles();
      createFloatingWidget();
    }

    // Trigger ready callback
    if (state.callbacks.onReady) {
      state.callbacks.onReady();
    }

    // Auto-start if configured
    if (state.config.autoStart) {
      setTimeout(() => startCall(), 1000);
    }
  }

  /**
   * Parse context variables from JSON string
   */
  function parseContextVariables(contextStr) {
    if (!contextStr) return {};
    try {
      return JSON.parse(contextStr);
    } catch (e) {
      console.warn('Dograh Widget: Invalid context variables', e);
      return {};
    }
  }

  /**
   * Normalize the configured modes list. Defaults to voice + chat.
   * Invalid entries are dropped; duplicates removed; order preserved.
   */
  function parseModes(rawModes) {
    const allowed = ['voice', 'chat'];
    if (!Array.isArray(rawModes) || rawModes.length === 0) {
      return ['voice', 'chat'];
    }
    const seen = [];
    for (const entry of rawModes) {
      const value = typeof entry === 'string' ? entry.toLowerCase() : '';
      if (allowed.includes(value) && !seen.includes(value)) {
        seen.push(value);
      }
    }
    return seen.length > 0 ? seen : ['voice', 'chat'];
  }

  /**
   * Whether both voice and chat modes are available (toggle visible).
   */
  function bothModesAvailable() {
    const modes = state.config.modes || [];
    return modes.includes('voice') && modes.includes('chat');
  }

  /**
   * Whether chat UI may be rendered at all.
   */
  function chatEnabled() {
    return (state.config.modes || []).includes('chat');
  }

  /**
   * Inject widget styles
   */
  function injectStyles() {
    if (document.getElementById('dograh-widget-styles')) return;

    const styles = `
      .dograh-widget-container {
        position: fixed;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      }

      .dograh-widget-container.bottom-right {
        bottom: 20px;
        right: 20px;
      }

      .dograh-widget-container.bottom-left {
        bottom: 20px;
        left: 20px;
      }

      .dograh-widget-container.top-right {
        top: 20px;
        right: 20px;
      }

      .dograh-widget-container.top-left {
        top: 20px;
        left: 20px;
      }

      .dograh-widget-cta {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 12px 20px;
        border: none;
        border-radius: 9999px;
        color: #ffffff;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
        max-width: calc(100vw - 40px);
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
        transition: filter 150ms ease, transform 100ms ease, box-shadow 200ms ease;
        animation: dograh-cta-in 220ms ease-out;
      }

      .dograh-widget-cta:hover {
        filter: brightness(1.08);
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
      }
      .dograh-widget-cta:active { transform: scale(0.98); }

      .dograh-widget-cta.dograh-state-connecting { background: #f59e0b !important; animation: dograh-pulse 1.6s infinite; }
      .dograh-widget-cta.dograh-state-connected  { background: #ef4444 !important; }
      .dograh-widget-cta.dograh-state-failed     { background: #ef4444 !important; opacity: 0.85; }

      @keyframes dograh-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.6; }
      }

      @keyframes dograh-cta-in {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;

    const styleSheet = document.createElement('style');
    styleSheet.id = 'dograh-widget-styles';
    styleSheet.textContent = styles;
    document.head.appendChild(styleSheet);
  }

  /**
   * Inject chat + mode-toggle styles (idempotent). Shared by floating and
   * inline modes so chat UI renders consistently in both.
   */
  function injectChatStyles() {
    if (document.getElementById('dograh-chat-styles')) return;

    const accent = state.config.buttonColor || '#10b981';

    const styles = `
      .dograh-widget-container {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .dograh-widget-container.bottom-right,
      .dograh-widget-container.top-right { align-items: flex-end; }
      .dograh-widget-container.bottom-left,
      .dograh-widget-container.top-left { align-items: flex-start; }

      .dograh-mode-toggle {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding: 3px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.95);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .dograh-mode-toggle-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border: none;
        background: transparent;
        border-radius: 9px;
        font-size: 13px;
        font-weight: 600;
        color: #4b5563;
        cursor: pointer;
        transition: background 150ms ease, color 150ms ease;
      }
      .dograh-mode-toggle-btn:hover { color: #111827; }
      .dograh-mode-toggle-btn.dograh-active {
        background: #111827;
        color: #ffffff;
      }

      .dograh-chat-panel {
        display: flex;
        flex-direction: column;
        background: #ffffff;
        border-radius: 16px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .dograh-chat-panel.dograh-chat-panel-floating {
        width: 340px;
        height: 460px;
      }
      .dograh-chat-panel.dograh-chat-panel-inline {
        width: 100%;
        height: 100%;
        flex: 1;
        min-height: 320px;
        border-radius: 12px;
      }

      .dograh-chat-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid #e5e7eb;
        background: #fafafa;
      }
      .dograh-chat-title {
        font-size: 14px;
        font-weight: 600;
        color: #111827;
      }
      .dograh-chat-status {
        font-size: 11px;
        font-weight: 500;
        color: #6b7280;
        text-transform: capitalize;
      }

      .dograh-chat-messages {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        background: #f9fafb;
      }
      .dograh-chat-empty {
        margin: auto;
        font-size: 13px;
        color: #9ca3af;
        text-align: center;
      }

      .dograh-chat-bubble {
        max-width: 78%;
        padding: 9px 13px;
        border-radius: 16px;
        font-size: 14px;
        line-height: 1.45;
        white-space: pre-wrap;
        word-wrap: break-word;
        animation: dograh-chat-in 160ms ease-out;
      }
      .dograh-chat-bubble.dograh-chat-user {
        align-self: flex-end;
        background: #111827;
        color: #ffffff;
        border-bottom-right-radius: 4px;
      }
      .dograh-chat-bubble.dograh-chat-assistant {
        align-self: flex-start;
        background: #ffffff;
        color: #111827;
        border: 1px solid #e5e7eb;
        border-bottom-left-radius: 4px;
        border-left: 3px solid ${accent};
      }

      .dograh-chat-typing {
        align-self: flex-start;
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-left: 3px solid ${accent};
        border-radius: 16px;
        border-bottom-left-radius: 4px;
        padding: 12px 14px;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .dograh-chat-typing span {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #9ca3af;
        animation: dograh-chat-bounce 1.2s infinite ease-in-out;
      }
      .dograh-chat-typing span:nth-child(2) { animation-delay: 0.15s; }
      .dograh-chat-typing span:nth-child(3) { animation-delay: 0.3s; }
      @keyframes dograh-chat-bounce {
        0%, 80%, 100% { transform: scale(0.6); opacity: 0.5; }
        40% { transform: scale(1); opacity: 1; }
      }
      @keyframes dograh-chat-in {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .dograh-chat-error {
        padding: 8px 12px;
        font-size: 12px;
        color: #b91c1c;
        background: #fef2f2;
        border-top: 1px solid #fee2e2;
        display: none;
      }
      .dograh-chat-error.dograh-visible { display: block; }

      .dograh-chat-input-row {
        display: flex;
        align-items: flex-end;
        gap: 8px;
        padding: 10px 12px;
        border-top: 1px solid #e5e7eb;
        background: #ffffff;
      }
      .dograh-chat-input {
        flex: 1;
        min-height: 40px;
        max-height: 120px;
        padding: 9px 12px;
        border: 1px solid #d1d5db;
        border-radius: 10px;
        font-size: 14px;
        line-height: 1.4;
        font-family: inherit;
        resize: none;
        outline: none;
        transition: border-color 150ms ease, box-shadow 150ms ease;
      }
      .dograh-chat-input:focus {
        border-color: ${accent};
        box-shadow: 0 0 0 3px ${accent}22;
      }
      .dograh-chat-input:disabled { background: #f3f4f6; cursor: not-allowed; }
      .dograh-chat-send {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 40px;
        min-width: 56px;
        padding: 0 14px;
        border: none;
        border-radius: 10px;
        background: ${accent};
        color: #ffffff;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: filter 150ms ease, transform 100ms ease;
      }
      .dograh-chat-send:hover { filter: brightness(1.08); }
      .dograh-chat-send:active { transform: scale(0.97); }
      .dograh-chat-send:disabled { opacity: 0.6; cursor: not-allowed; }
    `;

    const styleSheet = document.createElement('style');
    styleSheet.id = 'dograh-chat-styles';
    styleSheet.textContent = styles;
    document.head.appendChild(styleSheet);
  }

  function ctaLabelForStatus(status) {
    switch (status) {
      case 'connecting': return 'Connecting…';
      case 'connected':  return 'End Call';
      case 'failed':     return 'Retry';
      default:           return state.config.buttonText || 'Talk to Agent';
    }
  }

  /**
   * Create floating widget UI — a single CTA pill button anchored to the
   * configured corner of the viewport.
   */
  function createFloatingWidget() {
    const container = document.createElement('div');
    container.className = `dograh-widget-container ${state.config.position}`;
    container.id = 'dograh-widget-root';

    const audio = document.createElement('audio');
    audio.id = 'dograh-widget-audio';
    audio.autoplay = true;
    audio.style.display = 'none';
    container.appendChild(audio);
    state.audioElement = audio;

    document.body.appendChild(container);
    renderFloating();
  }

  /**
   * Build the voice CTA pill button for the current connection status.
   */
  function renderVoiceCta() {
    const status = state.connectionStatus || 'idle';

    const button = document.createElement('button');
    button.id = 'dograh-widget-cta';
    button.type = 'button';
    button.className = `dograh-widget-cta dograh-state-${status}`;
    // Idle uses configured color; status states use CSS-defined colors.
    if (status === 'idle') {
      button.style.backgroundColor = state.config.buttonColor;
    }
    button.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" y1="19" x2="12" y2="23"/>
        <line x1="8" y1="23" x2="16" y2="23"/>
      </svg>
      <span></span>
    `;
    button.querySelector('span').textContent = ctaLabelForStatus(status);
    button.onclick = toggleCall;

    return button;
  }

  /**
   * Build the segmented Voice|Chat mode toggle. Returns null when the toggle
   * should be hidden (single mode or chat unavailable).
   */
  function renderModeToggle() {
    if (!bothModesAvailable()) return null;

    const wrap = document.createElement('div');
    wrap.className = 'dograh-mode-toggle';

    const voiceBtn = document.createElement('button');
    voiceBtn.type = 'button';
    voiceBtn.className = 'dograh-mode-toggle-btn' + (state.mode === 'voice' ? ' dograh-active' : '');
    voiceBtn.textContent = 'Voice';
    voiceBtn.onclick = () => setMode('voice');

    const chatBtn = document.createElement('button');
    chatBtn.type = 'button';
    chatBtn.className = 'dograh-mode-toggle-btn' + (state.mode === 'chat' ? ' dograh-active' : '');
    chatBtn.textContent = 'Chat';
    chatBtn.onclick = () => setMode('chat');

    wrap.appendChild(voiceBtn);
    wrap.appendChild(chatBtn);
    return wrap;
  }

  /**
   * Render the floating CTA pill. Re-renders preserve the hidden audio
   * element so an in-progress call is not interrupted on status changes.
   */
  function renderFloating() {
    const container = document.getElementById('dograh-widget-root');
    if (!container) return;

    Array.from(container.children).forEach((child) => {
      if (child !== state.audioElement) container.removeChild(child);
    });

    const toggle = renderModeToggle();
    if (toggle) {
      injectChatStyles();
      container.appendChild(toggle);
    }

    if (state.mode === 'chat' && chatEnabled()) {
      injectChatStyles();
      container.appendChild(renderChatPanel('floating'));
    } else {
      container.appendChild(renderVoiceCta());
    }
  }

  /**
   * Build a single chat bubble element.
   */
  function renderChatBubble(role, text) {
    const bubble = document.createElement('div');
    bubble.className = 'dograh-chat-bubble ' + (role === 'user' ? 'dograh-chat-user' : 'dograh-chat-assistant');
    bubble.textContent = text;
    return bubble;
  }

  /**
   * Build the typing indicator (animated dots in an assistant bubble).
   */
  function renderChatTyping() {
    const typing = document.createElement('div');
    typing.className = 'dograh-chat-typing';
    typing.innerHTML = '<span></span><span></span><span></span>';
    return typing;
  }

  /**
   * Build the chat panel (header + messages + input). Used by both floating
   * and inline modes; `variant` controls sizing class.
   */
  function renderChatPanel(variant) {
    injectChatStyles();

    const panel = document.createElement('div');
    panel.className = `dograh-chat-panel dograh-chat-panel-${variant}`;
    panel.id = 'dograh-chat-panel';

    // Header
    const header = document.createElement('div');
    header.className = 'dograh-chat-header';
    const title = document.createElement('span');
    title.className = 'dograh-chat-title';
    title.textContent = 'Chat';
    const statusEl = document.createElement('span');
    statusEl.className = 'dograh-chat-status';
    statusEl.id = 'dograh-chat-status';
    statusEl.textContent = state.chatStatus || 'idle';
    header.appendChild(title);
    header.appendChild(statusEl);
    panel.appendChild(header);

    // Messages
    const messages = document.createElement('div');
    messages.className = 'dograh-chat-messages';
    messages.id = 'dograh-chat-messages';

    const visibleTurns = (state.chatTurns || []).filter(
      (turn) => (turn.user_message && turn.user_message.text) || (turn.assistant_message && turn.assistant_message.text)
    );

    if (visibleTurns.length === 0 && !state.chatSending) {
      const empty = document.createElement('div');
      empty.className = 'dograh-chat-empty';
      empty.textContent = 'Send a message to start the conversation.';
      messages.appendChild(empty);
    } else {
      for (const turn of state.chatTurns) {
        if (turn.user_message && turn.user_message.text) {
          messages.appendChild(renderChatBubble('user', turn.user_message.text));
        }
        if (turn.assistant_message && turn.assistant_message.text) {
          messages.appendChild(renderChatBubble('assistant', turn.assistant_message.text));
        }
      }
    }

    if (state.chatSending) {
      messages.appendChild(renderChatTyping());
    }

    panel.appendChild(messages);

    // Error banner
    const errorEl = document.createElement('div');
    errorEl.className = 'dograh-chat-error' + (state.chatError ? ' dograh-visible' : '');
    errorEl.id = 'dograh-chat-error';
    errorEl.textContent = state.chatError || '';
    panel.appendChild(errorEl);

    // Input row
    const inputRow = document.createElement('div');
    inputRow.className = 'dograh-chat-input-row';

    const input = document.createElement('textarea');
    input.className = 'dograh-chat-input';
    input.id = 'dograh-chat-input';
    input.rows = 1;
    input.placeholder = state.chatSending ? 'Sending...' : 'Send a message...';
    input.value = state.chatDraft || '';
    input.disabled = state.chatSending;
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (state.chatSending) return;
        const text = input.value;
        if (!text.trim()) return;
        sendChatMessage(text).then(() => {
          // Draft is cleared on successful send; refocus the fresh input.
          const fresh = document.getElementById('dograh-chat-input');
          if (fresh) fresh.focus();
        });
      }
    });
    input.addEventListener('input', () => {
      state.chatDraft = input.value;
    });

    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'dograh-chat-send';
    sendBtn.id = 'dograh-chat-send';
    sendBtn.textContent = state.chatSending ? 'Sending' : 'Send';
    sendBtn.disabled = state.chatSending || !(input.value || '').trim();
    sendBtn.addEventListener('click', () => {
      if (state.chatSending) return;
      const text = input.value;
      if (!text.trim()) return;
      sendChatMessage(text).then(() => {
        const fresh = document.getElementById('dograh-chat-input');
        if (fresh) fresh.focus();
      });
    });

    inputRow.appendChild(input);
    inputRow.appendChild(sendBtn);
    panel.appendChild(inputRow);

    // Defer auto-scroll until the panel is in the DOM.
    requestAnimationFrame(() => {
      const msgs = document.getElementById('dograh-chat-messages');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
      const focusInput = document.getElementById('dograh-chat-input');
      if (focusInput && !state.chatSending) focusInput.focus();
    });

    return panel;
  }

  /**
   * Re-render whichever surface is active (floating/inline chat panel or
   * voice UI) without disturbing an in-progress voice call.
   */
  function renderChat() {
    if (state.config.embedMode === 'floating') {
      renderFloating();
    } else if (state.config.embedMode === 'inline') {
      renderInline();
    }
  }

  /**
   * Switch between voice and chat modes. Switching to chat initializes a
   * chat session and renders the chat panel; switching to voice tears down
   * the chat UI and shows the voice CTA.
   */
  function setMode(nextMode) {
    if (nextMode !== 'voice' && nextMode !== 'chat') return;
    if (!(state.config.modes || []).includes(nextMode)) return;
    if (state.mode === nextMode) return;

    state.mode = nextMode;

    if (nextMode === 'chat') {
      renderChat();
      if (!state.chatSessionInited) {
        initChatSession();
      }
    } else {
      // Leaving chat: stop any pending send but keep the session for reuse.
      state.chatSending = false;
      renderChat();
    }
  }

  /**
   * Initialize a text-chat session via POST /text-chat/init.
   */
  async function initChatSession() {
    if (!state.config.token) {
      state.chatError = 'No embed token available for chat.';
      renderChat();
      return;
    }

    state.chatError = null;
    try {
      const response = await fetch(`${state.config.apiBaseUrl}/api/v1/public/embed/text-chat/init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': window.location.origin
        },
        body: JSON.stringify({
          token: state.config.token,
          context_variables: state.config.contextVariables || {}
        })
      });

      if (!response.ok) {
        let detail = `Failed to init chat session (${response.status})`;
        try {
          const errBody = await response.json();
          detail = errBody.message || errBody.detail || detail;
        } catch (e) { /* ignore parse error */ }
        throw new Error(detail);
      }

      const data = await response.json();
      const prevStatus = state.chatStatus;
      state.chatSessionToken = data.session_token;
      state.chatRunId = data.workflow_run_id;
      state.chatRevision = data.revision;
      state.chatTurns = Array.isArray(data.turns) ? data.turns : [];
      state.chatStatus = data.status || 'idle';
      state.chatSessionInited = true;
      state.chatError = null;

      fireChatStatusChange(prevStatus, state.chatStatus);
      renderChat();
    } catch (error) {
      console.error('Dograh Widget: chat init failed', error);
      state.chatSessionInited = false;
      state.chatError = error.message || 'Failed to start chat session.';
      renderChat();
    }
  }

  /**
   * Refresh chat session state via GET /text-chat/{session_token}.
   */
  async function refreshChatSession() {
    if (!state.chatSessionToken) return;
    try {
      const response = await fetch(`${state.config.apiBaseUrl}/api/v1/public/embed/text-chat/${state.chatSessionToken}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Origin': window.location.origin
        }
      });
      if (!response.ok) return;
      const data = await response.json();
      const prevStatus = state.chatStatus;
      state.chatRevision = data.revision;
      state.chatTurns = Array.isArray(data.turns) ? data.turns : [];
      state.chatStatus = data.status || state.chatStatus;
      fireChatStatusChange(prevStatus, state.chatStatus);
      renderChat();
    } catch (error) {
      console.warn('Dograh Widget: chat refresh failed', error);
    }
  }

  /**
   * Send a chat message via POST /text-chat/{session_token}/messages.
   * Auto-inits the session if needed; retries once on revision conflict (409).
   */
  async function sendChatMessage(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return;

    if (!state.chatSessionInited) {
      await initChatSession();
      if (!state.chatSessionInited) return;
    }

    state.chatSending = true;
    state.chatError = null;
    state.chatDraft = '';
    renderChat();

    try {
      const response = await fetch(`${state.config.apiBaseUrl}/api/v1/public/embed/text-chat/${state.chatSessionToken}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': window.location.origin
        },
        body: JSON.stringify({
          text: trimmed,
          expected_revision: state.chatRevision
        })
      });

      if (response.status === 409) {
        // Revision conflict: refresh once, then retry the send a single time.
        await refreshChatSession();
        state.chatSending = false;
        renderChat();
        await sendChatMessageOnce(trimmed);
        return;
      }

      if (!response.ok) {
        let detail = `Failed to send message (${response.status})`;
        try {
          const errBody = await response.json();
          detail = errBody.message || errBody.detail || detail;
        } catch (e) { /* ignore parse error */ }
        throw new Error(detail);
      }

      const data = await response.json();
      const prevStatus = state.chatStatus;
      state.chatRevision = data.revision;
      state.chatTurns = Array.isArray(data.turns) ? data.turns : [];
      state.chatStatus = data.status || state.chatStatus;
      state.chatSending = false;
      fireChatStatusChange(prevStatus, state.chatStatus);
      fireChatMessage();
      renderChat();
    } catch (error) {
      console.error('Dograh Widget: chat send failed', error);
      state.chatSending = false;
      state.chatError = error.message || 'Failed to send message.';
      renderChat();
    }
  }

  /**
   * Single send attempt without the 409-retry loop (used after a refresh).
   */
  async function sendChatMessageOnce(text) {
    state.chatSending = true;
    renderChat();
    try {
      const response = await fetch(`${state.config.apiBaseUrl}/api/v1/public/embed/text-chat/${state.chatSessionToken}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': window.location.origin
        },
        body: JSON.stringify({
          text: text,
          expected_revision: state.chatRevision
        })
      });
      if (!response.ok) {
        let detail = `Failed to send message (${response.status})`;
        try {
          const errBody = await response.json();
          detail = errBody.message || errBody.detail || detail;
        } catch (e) { /* ignore */ }
        throw new Error(detail);
      }
      const data = await response.json();
      const prevStatus = state.chatStatus;
      state.chatRevision = data.revision;
      state.chatTurns = Array.isArray(data.turns) ? data.turns : [];
      state.chatStatus = data.status || state.chatStatus;
      state.chatSending = false;
      fireChatStatusChange(prevStatus, state.chatStatus);
      fireChatMessage();
      renderChat();
    } catch (error) {
      console.error('Dograh Widget: chat send retry failed', error);
      state.chatSending = false;
      state.chatError = error.message || 'Failed to send message.';
      renderChat();
    }
  }

  function fireChatMessage() {
    if (state.chatCallbacks.onChatMessage) {
      const last = state.chatTurns[state.chatTurns.length - 1];
      const assistantText = last && last.assistant_message ? last.assistant_message.text : null;
      state.chatCallbacks.onChatMessage({
        turns: state.chatTurns,
        status: state.chatStatus,
        revision: state.chatRevision,
        lastAssistantMessage: assistantText
      });
    }
  }

  function fireChatStatusChange(prev, next) {
    if (state.chatCallbacks.onChatStatusChange && prev !== next) {
      state.chatCallbacks.onChatStatusChange(next, prev);
    }
  }

  /**
   * Create headless widget (no UI — host page drives everything via window.DograhWidget API)
   */
  function createHeadlessWidget() {
    const audio = document.createElement('audio');
    audio.id = 'dograh-widget-audio';
    audio.autoplay = true;
    audio.style.display = 'none';
    document.body.appendChild(audio);
    state.audioElement = audio;
  }

  /**
   * Toggle call (start or stop based on current state). No-op while the
   * widget is in chat mode — the mode toggle controls which UI is active.
   */
  function toggleCall() {
    if (state.mode === 'chat') return;
    if (state.connectionStatus === 'idle' || state.connectionStatus === 'failed') {
      startCall();
    } else {
      stopCall();
    }
  }

  function updateFloatingButton(status) {
    state.connectionStatus = status;
    renderFloating();
  }

  /**
   * Create inline widget UI
   */
  function createInlineWidget() {
    // Find container element
    const container = document.getElementById(state.config.containerId);
    if (!container) {
      console.error(`Dograh Widget: Container element with id "${state.config.containerId}" not found`);
      if (state.callbacks.onError) {
        state.callbacks.onError(new Error('Container element not found'));
      }
      return;
    }

    // Clear container
    container.innerHTML = '';
    container.className = 'dograh-inline-container';

    // Inline styles (voice status + container layout for toggle/chat).
    const inlineStyles = `
      .dograh-inline-container {
        min-height: 200px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .dograh-inline-voice-wrap {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .dograh-inline-status {
        text-align: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }

      .dograh-inline-status-icon {
        width: 64px;
        height: 64px;
        margin: 0 auto 20px;
      }

      .dograh-inline-status-text {
        font-size: 18px;
        font-weight: 500;
        margin: 0 0 8px;
        color: #111827;
      }

      .dograh-inline-status-subtext {
        font-size: 14px;
        color: #6b7280;
        margin: 0 0 20px;
      }

      .dograh-inline-button-container {
        display: flex;
        gap: 12px;
        justify-content: center;
        margin-top: 20px;
      }

      .dograh-inline-btn {
        padding: 12px 32px;
        border-radius: 8px;
        border: none;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s;
        color: white;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      }

      .dograh-inline-btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      }

      .dograh-inline-btn:active {
        transform: translateY(0);
      }

      .dograh-inline-btn-start {
        background: #10b981;
      }

      .dograh-inline-btn-start:hover {
        background: #059669;
      }

      .dograh-inline-btn-end {
        background: #ef4444;
      }

      .dograh-inline-btn-end:hover {
        background: #dc2626;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }

      .dograh-inline-pulse {
        animation: pulse 2s infinite;
      }
    `;

    // Add inline styles if not already added
    if (!document.getElementById('dograh-inline-styles')) {
      const styleSheet = document.createElement('style');
      styleSheet.id = 'dograh-inline-styles';
      styleSheet.textContent = inlineStyles;
      document.head.appendChild(styleSheet);
    }

    // Store audio element (hidden) before first render so it persists.
    state.audioElement = document.createElement('audio');
    state.audioElement.autoplay = true;
    state.audioElement.style.display = 'none';
    container.appendChild(state.audioElement);

    // Mark widget as open (for inline mode, it's always "open")
    state.isOpen = true;

    // Initial render (toggle + voice status or chat panel).
    renderInline();
  }

  /**
   * Render the inline surface: mode toggle (if both modes) plus either the
   * chat panel (chat mode) or the voice status display (voice mode).
   * Preserves the hidden audio element across re-renders.
   */
  function renderInline() {
    const container = document.getElementById(state.config.containerId);
    if (!container) return;

    Array.from(container.children).forEach((child) => {
      if (child !== state.audioElement) container.removeChild(child);
    });

    const toggle = renderModeToggle();
    if (toggle) {
      injectChatStyles();
      container.appendChild(toggle);
    }

    if (state.mode === 'chat' && chatEnabled()) {
      injectChatStyles();
      container.appendChild(renderChatPanel('inline'));
    } else {
      container.appendChild(renderInlineVoice(state.connectionStatus));
    }
  }

  /**
   * Build the inline voice status display (icon + text + start/end button).
   */
  function renderInlineVoice(status) {
    const wrap = document.createElement('div');
    wrap.className = 'dograh-inline-voice-wrap';

    const displayText = state.inlineDisplayText || {
      idle: 'Ready to Connect',
      connecting: 'Connecting...',
      connected: 'Call Active',
      failed: 'Connection Failed'
    }[status];

    const displaySubtext = state.inlineDisplaySubtext || {
      idle: state.config.callToActionText,
      connecting: 'Please wait while we establish connection',
      connected: 'You can speak now',
      failed: 'Please check your microphone and try again'
    }[status];

    let buttonHTML = '';
    if (status === 'idle' || status === 'failed') {
      buttonHTML = `
        <button class="dograh-inline-btn dograh-inline-btn-start" id="dograh-inline-start-btn" style="background: ${state.config.buttonColor};">
          ${status === 'failed' ? 'Retry' : state.config.buttonText}
        </button>
      `;
    } else if (status === 'connecting' || status === 'connected') {
      buttonHTML = `
        <button class="dograh-inline-btn dograh-inline-btn-end" id="dograh-inline-end-btn">
          End Call
        </button>
      `;
    }

    wrap.innerHTML = `
      <div class="dograh-inline-status">
        <div class="dograh-inline-status-icon ${status === 'connecting' ? 'dograh-inline-pulse' : ''}">
          ${getStatusIcon(status)}
        </div>
        <p class="dograh-inline-status-text">${displayText}</p>
        <p class="dograh-inline-status-subtext">${displaySubtext}</p>
        <div class="dograh-inline-button-container">
          ${buttonHTML}
        </div>
      </div>
    `;

    const startBtn = wrap.querySelector('#dograh-inline-start-btn');
    if (startBtn) startBtn.onclick = startCall;

    const endBtn = wrap.querySelector('#dograh-inline-end-btn');
    if (endBtn) endBtn.onclick = stopCall;

    return wrap;
  }

  /**
   * Update inline widget status. Stores the resolved display text, fires the
   * status-change callback, and re-renders the voice surface — unless the
   * widget is in chat mode, in which case the chat panel stays put.
   */
  function updateInlineStatus(status, text, subtext) {
    const container = document.getElementById(state.config.containerId);
    if (!container) return;

    // Update state
    state.connectionStatus = status;

    // Determine display text
    const displayText = text || {
      idle: 'Ready to Connect',
      connecting: 'Connecting...',
      connected: 'Call Active',
      failed: 'Connection Failed'
    }[status];

    const displaySubtext = subtext || {
      idle: state.config.callToActionText,
      connecting: 'Please wait while we establish connection',
      connected: 'You can speak now',
      failed: 'Please check your microphone and try again'
    }[status];

    state.inlineDisplayText = displayText;
    state.inlineDisplaySubtext = displaySubtext;

    // Trigger status change callback
    if (state.callbacks.onStatusChange) {
      state.callbacks.onStatusChange(status, displayText, displaySubtext);
    }

    // In chat mode the chat panel owns the surface; do not overwrite it.
    if (state.mode === 'chat' && chatEnabled()) return;

    renderInline();
  }

  /**
   * Get status icon SVG
   */
  function getStatusIcon(status) {
    const icons = {
      idle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" y1="19" x2="12" y2="23"/>
        <line x1="8" y1="23" x2="16" y2="23"/>
      </svg>`,
      connecting: `<svg class="dograh-widget-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2v4"/>
        <path d="M12 18v4"/>
        <path d="M4.93 4.93l2.83 2.83"/>
        <path d="M16.24 16.24l2.83 2.83"/>
        <path d="M2 12h4"/>
        <path d="M18 12h4"/>
        <path d="M4.93 19.07l2.83-2.83"/>
        <path d="M16.24 7.76l2.83-2.83"/>
      </svg>`,
      connected: `<svg viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72"/>
        <path d="M15 7a2 2 0 0 1 2 2"/>
        <path d="M15 3a6 6 0 0 1 6 6"/>
      </svg>`,
      failed: `<svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>`
    };
    return icons[status] || icons.idle;
  }

  /**
   * Update widget status
   */
  function updateStatus(status, text, subtext) {
    state.connectionStatus = status;

    // Use appropriate update function based on mode
    if (state.config.embedMode === 'inline') {
      updateInlineStatus(status, text, subtext);
    } else if (state.config.embedMode === 'headless') {
      if (state.callbacks.onStatusChange) {
        state.callbacks.onStatusChange(status, text, subtext);
      }
    } else {
      updateFloatingButton(status);
    }
  }

  /**
   * Open widget (deprecated - kept for backwards compatibility)
   */
  function openWidget() {
    // No-op since we removed the modal
  }

  /**
   * Close widget (deprecated - kept for backwards compatibility)
   */
  function closeWidget() {
    // Stop call if active
    if (state.connectionStatus === 'connected' || state.connectionStatus === 'connecting') {
      stopCall();
    }
  }

  /**
   * Start voice call
   */
  async function startCall() {
    if (state.mode === 'chat') return;
    state.gracefulDisconnect = false;
    updateStatus('connecting', 'Connecting...', 'Please wait while we establish the connection');

    if (state.callbacks.onCallStart) {
      state.callbacks.onCallStart();
    }

    try {
      // Initialize session if using embed token
      if (state.config.token) {
        await initializeEmbedSession();
      } else {
        // Direct mode with workflow and run IDs
        state.sessionToken = 'direct-mode';
        state.workflowRunId = state.config.runId;
      }

      // Request microphone permission
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Release any stream still held from a prior attempt before retaining
        // the new one, so a re-entrant start can't leak the microphone.
        if (state.stream) {
          state.stream.getTracks().forEach(track => track.stop());
        }
        state.stream = stream;
      } catch (micError) {
        // Handle specific microphone permission errors
        let errorMessage = 'Please check your microphone and try again';

        if (micError.name === 'NotAllowedError' || micError.name === 'PermissionDeniedError') {
          errorMessage = 'Microphone permission denied. Please allow microphone access to start the call.';
        } else if (micError.name === 'NotFoundError' || micError.name === 'DevicesNotFoundError') {
          errorMessage = 'No microphone found. Please connect a microphone and try again.';
        } else if (micError.name === 'NotReadableError' || micError.name === 'TrackStartError') {
          errorMessage = 'Microphone is already in use by another application.';
        }

        throw new Error(errorMessage);
      }

      // Create WebRTC connection
      await createWebRTCConnection();

      // Connect WebSocket
      await connectWebSocket();

      // Start negotiation
      await negotiate();

    } catch (error) {
      console.error('Dograh Widget: Failed to start call', error);

      // Release anything acquired before the failure so a retry starts clean.
      // getUserMedia may have succeeded before a later step (WebSocket /
      // negotiation) threw, which would otherwise leave the mic held and block
      // the next getUserMedia(). Null the refs before close() so the peer/ws
      // state handlers short-circuit instead of re-entering teardown.
      if (state.stream) {
        state.stream.getTracks().forEach(track => track.stop());
        state.stream = null;
      }
      if (state.pc) {
        const pc = state.pc;
        state.pc = null;
        if (pc.signalingState !== 'closed') {
          pc.close();
        }
      }
      if (state.ws) {
        const ws = state.ws;
        state.ws = null;
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }

      updateStatus('failed', 'Connection failed', error.message || 'Please check your microphone and try again');

      // Trigger error callback
      if (state.callbacks.onError) {
        state.callbacks.onError(error);
      }
    }
  }

  /**
   * Initialize embed session
   */
  async function initializeEmbedSession() {
    const response = await fetch(`${state.config.apiBaseUrl}/api/v1/public/embed/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': window.location.origin
      },
      body: JSON.stringify({
        token: state.config.token,
        context_variables: state.config.contextVariables
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to initialize session');
    }

    const data = await response.json();
    state.sessionToken = data.session_token;
    state.workflowRunId = data.workflow_run_id;
    state.workflowId = data.config.workflow_id;

    // Fetch TURN credentials after session initialization
    await fetchTurnCredentials();
  }

  /**
   * Fetch TURN credentials for WebRTC connection
   */
  async function fetchTurnCredentials() {
    if (!state.sessionToken) {
      console.warn('Dograh Widget: No session token available for TURN credentials');
      return;
    }

    try {
      const response = await fetch(`${state.config.apiBaseUrl}/api/v1/public/embed/turn-credentials/${state.sessionToken}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Origin': window.location.origin
        }
      });

      if (response.ok) {
        state.turnCredentials = await response.json();
        console.log(`TURN credentials obtained, TTL: ${state.turnCredentials.ttl}s`);
      } else if (response.status === 503) {
        // TURN not configured on server - this is OK, we'll use STUN only
        console.log('TURN server not configured, using STUN only');
      } else {
        console.warn(`Failed to fetch TURN credentials: ${response.status}`);
      }
    } catch (error) {
      console.warn('Failed to fetch TURN credentials, continuing without TURN:', error);
    }
  }

  /**
   * Create WebRTC peer connection
   */
  function createWebRTCConnection() {
    // Build ICE servers list
    const iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];

    // Add TURN server if credentials are available
    if (state.turnCredentials && state.turnCredentials.uris && state.turnCredentials.uris.length > 0) {
      iceServers.push({
        urls: state.turnCredentials.uris,
        username: state.turnCredentials.username,
        credential: state.turnCredentials.password
      });
      console.log(`TURN server configured with ${state.turnCredentials.uris.length} URIs`);
    }

    const config = {
      iceServers: iceServers
    };

    state.pc = new RTCPeerConnection(config);

    // Add audio track
    if (state.stream) {
      state.stream.getTracks().forEach(track => {
        state.pc.addTrack(track, state.stream);
      });
    }

    // Handle incoming audio
    state.pc.ontrack = (event) => {
      if (event.track.kind === 'audio' && state.audioElement) {
        state.audioElement.srcObject = event.streams[0];
      }
    };

    // Monitor connection state
    state.pc.oniceconnectionstatechange = handlePeerConnectionStateChange;
    state.pc.onconnectionstatechange = handlePeerConnectionStateChange;
    state.pc.onicecandidate = sendIceCandidate;
  }

  function handlePeerConnectionStateChange() {
    const pc = state.pc;
    if (!pc) return;

    console.log('Peer connection state:', pc.connectionState, 'ICE:', pc.iceConnectionState);

    if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      const wasAlreadyConnected = state.callStartedAt !== null;
      updateStatus('connected', 'Connected', 'Your voice call is now active');
      if (!wasAlreadyConnected) {
        state.callStartedAt = Date.now();
        if (state.callbacks.onCallConnected) {
          state.callbacks.onCallConnected({
            agentId: state.config.workflowId || null,
            token: state.config.token || null,
            workflowRunId: state.workflowRunId || null
          });
        }
      }
      return;
    }

    if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') {
      stopCall({
        graceful: false,
        status: 'failed',
        text: 'Connection lost',
        subtext: 'The call has been disconnected'
      });
      return;
    }

    if (
      pc.connectionState === 'closed' ||
      pc.connectionState === 'disconnected' ||
      pc.iceConnectionState === 'closed' ||
      pc.iceConnectionState === 'disconnected'
    ) {
      stopCall({ graceful: true });
    }
  }

  function sendIceCandidate(event) {
    // Handle ICE candidates for trickling
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      const message = {
        type: 'ice-candidate',
        payload: {
          candidate: event.candidate ? {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex
          } : null,
          pc_id: state.pcId
        }
      };
      state.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Connect WebSocket for signaling
   */
  async function connectWebSocket() {
    return new Promise((resolve, reject) => {
      // Use public signaling endpoint for embed tokens
      const wsUrl = `${state.config.apiBaseUrl.replace('http', 'ws')}/api/v1/ws/public/signaling/${state.sessionToken}`;

      state.ws = new WebSocket(wsUrl);
      state.pcId = generatePeerId();

      state.ws.onopen = () => {
        console.log('WebSocket connected');
        resolve();
      };

      state.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      };

      state.ws.onclose = (event) => {
        console.log('WebSocket closed');
        state.ws = null;

        if (event.reason === 'call ended') {
          stopCall({ graceful: true, closeWebSocket: false });
          return;
        }

        if (state.connectionStatus === 'connected' && !state.gracefulDisconnect) {
          updateStatus('failed', 'Connection lost', 'The call has been disconnected');
        }
      };

      state.ws.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data);
          await handleWebSocketMessage(message);
        } catch (e) {
          console.error('Failed to handle WebSocket message:', e);
        }
      };
    });
  }

  /**
   * Handle WebSocket messages
   */
  async function handleWebSocketMessage(message) {
    switch (message.type) {
      case 'answer':
        const answer = message.payload;
        console.log('Received answer from server');

        await state.pc.setRemoteDescription({
          type: 'answer',
          sdp: answer.sdp
        });
        break;

      case 'ice-candidate':
        const candidate = message.payload.candidate;
        if (candidate) {
          try {
            await state.pc.addIceCandidate({
              candidate: candidate.candidate,
              sdpMid: candidate.sdpMid,
              sdpMLineIndex: candidate.sdpMLineIndex
            });
            console.log('Added remote ICE candidate');
          } catch (e) {
            console.error('Failed to add ICE candidate:', e);
          }
        }
        break;

      case 'error':
        console.error('Server error:', message.payload);
        updateStatus('failed', 'Server error', message.payload.message || 'An error occurred');
        break;

      case 'call-ended':
        console.log('Call ended by server:', message.payload);
        stopCall({ graceful: true });
        break;

      default:
        console.warn('Unknown message type:', message.type);
    }
  }

  /**
   * Negotiate WebRTC connection
   */
  async function negotiate() {
    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);

    const message = {
      type: 'offer',
      payload: {
        sdp: offer.sdp,
        type: 'offer',
        pc_id: state.pcId,
        workflow_id: parseInt(state.config.workflowId),
        workflow_run_id: parseInt(state.workflowRunId),
        call_context_vars: state.config.contextVariables || {}
      }
    };

    state.ws.send(JSON.stringify(message));
    console.log('Sent offer via WebSocket');
  }

  /**
   * Stop voice call
   */
  function stopCall(options = {}) {
    const graceful = options.graceful !== false;
    const closeWebSocket = options.closeWebSocket !== false;
    const status = options.status || 'idle';
    const text = options.text || 'Call ended';
    const subtext = options.subtext || 'Click below to start a new call';

    state.gracefulDisconnect = graceful;

    // Fire onCallDisconnected only if the call had actually connected, with
    // identifiers and duration. Must run before we clear callStartedAt.
    if (state.callStartedAt && state.callbacks.onCallDisconnected) {
      const durationSeconds = Math.round((Date.now() - state.callStartedAt) / 1000);
      state.callbacks.onCallDisconnected({
        agentId: state.config.workflowId || null,
        token: state.config.token || null,
        workflowRunId: state.workflowRunId || null,
        durationSeconds
      });
    }
    state.callStartedAt = null;

    updateStatus(status, text, subtext);

    if (state.callbacks.onCallEnd) {
      state.callbacks.onCallEnd();
    }

    // Close WebSocket
    if (closeWebSocket && state.ws) {
      const ws = state.ws;
      state.ws = null;
      if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        ws.close();
      }
    } else if (!closeWebSocket) {
      state.ws = null;
    }

    // Stop media tracks
    if (state.stream) {
      state.stream.getTracks().forEach(track => track.stop());
      state.stream = null;
    }

    // Close peer connection
    if (state.pc) {
      const pc = state.pc;
      state.pc = null;
      if (pc.signalingState !== 'closed') {
        pc.close();
      }
    }

    // Clear audio
    if (state.audioElement) {
      state.audioElement.srcObject = null;
    }
  }

  /**
   * Retry connection
   */
  function retryCall() {
    updateStatus('idle', 'Ready to start', 'Click below to begin your voice call');
    setTimeout(() => startCall(), 500);
  }

  /**
   * Generate unique peer ID
   */
  function generatePeerId() {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return 'PC-' + Array.from(array)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // Public API
  window.DograhWidget = {
    // Core methods
    init: init,
    start: startCall,
    stop: stopCall,
    end: stopCall, // Alias for stop
    retry: retryCall,

    // Floating widget specific
    open: openWidget,
    close: closeWidget,

    // State and callbacks
    getState: () => state,
    onReady: (callback) => { state.callbacks.onReady = callback; },
    onCallStart: (callback) => { state.callbacks.onCallStart = callback; },
    onCallConnected: (callback) => { state.callbacks.onCallConnected = callback; },
    onCallDisconnected: (callback) => { state.callbacks.onCallDisconnected = callback; },
    onCallEnd: (callback) => { state.callbacks.onCallEnd = callback; },
    onError: (callback) => { state.callbacks.onError = callback; },
    onStatusChange: (callback) => { state.callbacks.onStatusChange = callback; },

    // Text-chat API
    setMode: (mode) => setMode(mode),
    getMode: () => state.mode,
    getModes: () => (state.config.modes || []).slice(),
    startChat: () => {
      if (!chatEnabled()) return Promise.resolve(false);
      setMode('chat');
      if (!state.chatSessionInited) {
        return initChatSession().then(() => state.chatSessionInited);
      }
      return Promise.resolve(true);
    },
    sendChatMessage: (text) => sendChatMessage(text),
    refreshChat: () => refreshChatSession(),
    onChatMessage: (callback) => { state.chatCallbacks.onChatMessage = callback; },
    onChatStatusChange: (callback) => { state.chatCallbacks.onChatStatusChange = callback; },
    getChatState: () => ({
      sessionToken: state.chatSessionToken,
      workflowRunId: state.chatRunId,
      revision: state.chatRevision,
      turns: state.chatTurns,
      status: state.chatStatus,
      sending: state.chatSending,
      sessionInited: state.chatSessionInited,
      error: state.chatError
    }),

    // Check if inline mode
    isInlineMode: () => state.config.embedMode === 'inline',

    // Re-render the active widget surface (inline or floating)
    refresh: () => {
      if (state.config.embedMode === 'inline') {
        updateInlineStatus(state.connectionStatus);
      } else if (state.config.embedMode === 'floating') {
        renderFloating();
      }
    },

    // Initialize inline mode manually (for advanced use cases)
    initInline: (options) => {
      if (options.container) {
        state.config.containerId = options.container.id || 'dograh-inline-container';
      }
      state.config.embedMode = 'inline';

      // Set callbacks if provided
      if (options.onReady) state.callbacks.onReady = options.onReady;
      if (options.onCallStart) state.callbacks.onCallStart = options.onCallStart;
      if (options.onCallConnected) state.callbacks.onCallConnected = options.onCallConnected;
      if (options.onCallDisconnected) state.callbacks.onCallDisconnected = options.onCallDisconnected;
      if (options.onCallEnd) state.callbacks.onCallEnd = options.onCallEnd;
      if (options.onError) state.callbacks.onError = options.onError;
      if (options.onStatusChange) state.callbacks.onStatusChange = options.onStatusChange;
      if (options.onChatMessage) state.chatCallbacks.onChatMessage = options.onChatMessage;
      if (options.onChatStatusChange) state.chatCallbacks.onChatStatusChange = options.onChatStatusChange;

      // Initialize
      if (!state.isInitialized) {
        init();
      }
    }
  };

  // Auto-initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
