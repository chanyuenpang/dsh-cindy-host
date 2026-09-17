/**
 * DSH Web half of the Cindy Host bundle: the 「Cindy 手机连接」 page in Settings.
 *
 * The page is a `settings.section` contribution, not a `settings.plugin.item`
 * card: it carries a connection switch, a Cindy sign-in flow and a device list,
 * and the shell's section slot is exactly the seat for "a feature owns its own
 * settings page" (`dsh-client-ui-settings` slot contract) — adding it required
 * no change to the shell.
 *
 * Hand-written as a Cordis client bundle because this package is distributed
 * outside the DSH repository and has no build step. The envelope below is the
 * one `dsh-client-modules` serves and `@deepseek-ai/dsh-client-ui-settings-general`
 * itself uses: a `window.__ModuleLoader__.load({ id, factory })` registration
 * whose factory returns a CommonJS-shaped module exporting `apply` and `inject`.
 *
 * Everything this page draws comes from the Host: the switch is a settings
 * write, and the connection state is whatever `GET /api/dsh-cindy-host/status`
 * last answered. The page never infers a connection from its own clicks.
 */
window.__ModuleLoader__.load({
  id: "dsh-cindy-host-demo",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;

    /** Settings namespace this card owns; the slot is keyed by it. */
    const NAMESPACE = "dsh-cindy-host";
    /** Host API prefix registered by `src/host-routes.js`. */
    const API = "/api/dsh-cindy-host";
    /** How often the card re-reads Host status while mounted. */
    const POLL_MS = 1500;

    const ZH = !String((typeof navigator !== "undefined" && navigator.language) || "zh").toLowerCase().startsWith("en");

    const TEXT = ZH
      ? {
          title: "Cindy 手机连接",
          description: "让 Cindy 手机客户端连上这台 DSH Host。",
          switchLabel: "连接手机",
          switchHint: "打开后本机登录 Cindy 并接入 DeviceLink，手机即可在设备列表中找到这台 Host。",
          stateDisconnected: "未连接",
          stateAuthenticating: "登录中",
          stateConnecting: "正在重连",
          stateWaiting: "等待手机连接",
          stateConnected: "已连接",
          stateFailed: "连接失败",
          reconnect: "重新连接",
          loginTitle: "登录 Cindy",
          loginHint: "本机还没有 Cindy 登录态。用与手机相同的账号登录。",
          kindPhone: "手机号",
          kindEmail: "邮箱",
          identifierPhone: "手机号",
          identifierEmail: "邮箱地址",
          code: "验证码",
          sendCode: "获取验证码",
          sending: "发送中…",
          codeSent: "验证码已发送",
          signIn: "登录",
          signingIn: "登录中…",
          logout: "退出登录",
          devices: "已连接设备",
          deviceOffline: "离线",
          deviceOnline: "在线",
          unknownPlatform: "未知平台",
          hostDevice: "本机设备",
          noDevices: "还没有手机连上这台 Host。",
          unavailable: "Cindy Host 设置命名空间不可用，请确认插件已在本机加载。",
          statusUnavailable: "读取 Host 状态失败，正在重试…",
          selectAccount: "请选择要登录的账户",
        }
      : {
          title: "Cindy Phone Link",
          description: "Let the Cindy mobile app connect to this DSH Host.",
          switchLabel: "Connect phone",
          switchHint: "Signs this Host in to Cindy and joins DeviceLink so the phone can find it.",
          stateDisconnected: "Not connected",
          stateAuthenticating: "Signing in",
          stateConnecting: "Reconnecting",
          stateWaiting: "Waiting for phone",
          stateConnected: "Connected",
          stateFailed: "Connection failed",
          reconnect: "Reconnect",
          loginTitle: "Sign in to Cindy",
          loginHint: "This Host has no Cindy session yet. Use the same account as your phone.",
          kindPhone: "Phone",
          kindEmail: "Email",
          identifierPhone: "Phone number",
          identifierEmail: "Email address",
          code: "Verification code",
          sendCode: "Send code",
          sending: "Sending…",
          codeSent: "Verification code sent",
          signIn: "Sign in",
          signingIn: "Signing in…",
          logout: "Sign out",
          devices: "Connected devices",
          deviceOffline: "offline",
          deviceOnline: "online",
          unknownPlatform: "unknown platform",
          hostDevice: "This Host",
          noDevices: "No phone has reached this Host yet.",
          unavailable: "The Cindy Host settings namespace is unavailable on this deployment.",
          statusUnavailable: "Reading Host status failed; retrying…",
          selectAccount: "Choose the account to sign in with",
        };

    /** Color for one connection state. */
    function stateColor(state) {
      switch (state) {
        case "connected":
          return "var(--dsw-alias-state-success-primary, #3fb950)";
        case "failed":
          return "var(--dsw-alias-state-error-primary, #e5534b)";
        case "connecting":
        case "waiting":
          return "var(--dsw-alias-state-warn-primary, #d29922)";
        default:
          return "var(--dsw-alias-label-tertiary, #8b949e)";
      }
    }

    function stateText(state, fallback) {
      switch (state) {
        case "disconnected":
          return TEXT.stateDisconnected;
        case "authenticating":
          return TEXT.stateAuthenticating;
        // A lost connection is retried automatically; showing it as a *failure* is what
        // made the phone's owner think the Host was gone and reach for the reconnect
        // button. This state is the honest middle ground (`host-reconnect.js`).
        case "connecting":
          return TEXT.stateConnecting;
        case "waiting":
          return TEXT.stateWaiting;
        case "connected":
          return TEXT.stateConnected;
        case "failed":
          return TEXT.stateFailed;
        default:
          return fallback || TEXT.stateDisconnected;
      }
    }

    function platformText(platform) {
      if (typeof platform !== "string" || platform === "") return TEXT.unknownPlatform;
      if (platform === "android") return "Android";
      if (platform === "ios") return "iOS";
      if (platform === "darwin") return "macOS";
      if (platform === "win32") return "Windows";
      if (platform === "linux") return "Linux";
      return platform;
    }

    /**
     * Derive everything the card draws from the two inputs it is allowed to
     * trust: the Host status and the settings snapshot. Pure, so the markup
     * rules are testable without a browser.
     * @param status - last status the Host answered, or null before the first poll.
     * @param scopeSnapshot - the bound settings-scope snapshot.
     * @returns the view model the card renders.
     */
    function resolveCardView(status, scopeSnapshot) {
      const value = (scopeSnapshot && scopeSnapshot.value) || {};
      const login = (status && status.login) || { authenticated: false, required: false };
      return {
        switchOn: value.transportEnabled === true || value.remoteControlEnabled === true,
        writable: !!scopeSnapshot && scopeSnapshot.status === "ready" && scopeSnapshot.writable !== false,
        unavailable: !!scopeSnapshot && scopeSnapshot.status === "unavailable",
        state: status ? status.state : "disconnected",
        stateLabel: stateText(status && status.state, status && status.stateLabel),
        message: (status && status.message) || null,
        devices: status && Array.isArray(status.devices) ? status.devices : [],
        login,
        host: (status && status.host) || null,
        showLogin: login.required === true,
        showReconnect: (status ? status.state : "disconnected") === "failed" && login.required !== true,
      };
    }

    /**
     * Move the phone switch through the settings scope.
     *
     * Both spellings move together: `transportEnabled` is the card's own field,
     * `remoteControlEnabled` is what a hand-edited document or the CLI path uses
     * for the same intent. The Host reads the union, so leaving one behind would
     * make the switch disagree with the socket.
     * @param scope - the bound `dsh-cindy-host` settings scope.
     * @param next - the requested switch position.
     */
    async function writeSwitch(scope, next) {
      await scope.set("transportEnabled", next);
      await scope.set("remoteControlEnabled", next);
    }

    /** POST JSON to the Host API and always resolve to a parsed body. */
    async function postJson(path, body) {
      const response = await fetch(API + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body === undefined ? {} : body),
      });
      try {
        return await response.json();
      } catch {
        return { ok: false, message: "Cindy Host 返回了无效响应" };
      }
    }

    const styles = {
      // A settings page fills the panel's content column, so it draws no card
      // chrome of its own — only the column layout.
      page: {
        display: "flex",
        flexDirection: "column",
        gap: "16px",
      },
      header: { display: "flex", flexDirection: "column", gap: "2px" },
      title: { fontSize: "14px", fontWeight: 600, color: "var(--dsw-alias-label-primary, #e6edf3)", lineHeight: 1.5 },
      description: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #8b949e)", lineHeight: 1.5, margin: 0 },
      row: { display: "flex", alignItems: "center", gap: "10px" },
      rowText: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0, flex: 1 },
      label: { fontSize: "13px", fontWeight: 500, color: "var(--dsw-alias-label-primary, #e6edf3)" },
      hint: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #8b949e)", lineHeight: 1.5 },
      statusRow: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--dsw-alias-label-secondary, #9da7b3)" },
      dot: { width: "8px", height: "8px", borderRadius: "50%", flexShrink: 0 },
      form: { display: "flex", flexDirection: "column", gap: "8px", borderTop: "0.5px solid var(--dsw-alias-border-l2, #30363d)", paddingTop: "12px" },
      field: { display: "flex", flexDirection: "column", gap: "4px" },
      input: {
        height: "32px",
        borderRadius: "8px",
        border: "0.5px solid var(--dsw-alias-border-l4, #484f58)",
        background: "var(--dsw-alias-bg-layer-3, #161b22)",
        color: "var(--dsw-alias-label-primary, #e6edf3)",
        padding: "0 10px",
        fontSize: "13px",
        fontFamily: "inherit",
      },
      button: {
        height: "32px",
        borderRadius: "8px",
        border: "0.5px solid var(--dsw-alias-border-l4, #484f58)",
        background: "var(--dsw-alias-button-primary-fill, #238636)",
        color: "var(--dsw-alias-label-primary-foreground, #ffffff)",
        fontSize: "13px",
        fontFamily: "inherit",
        cursor: "pointer",
        padding: "0 12px",
      },
      buttonGhost: {
        height: "30px",
        borderRadius: "8px",
        border: "0.5px solid var(--dsw-alias-border-l4, #484f58)",
        background: "transparent",
        color: "var(--dsw-alias-label-secondary, #9da7b3)",
        fontSize: "12px",
        fontFamily: "inherit",
        cursor: "pointer",
        padding: "0 10px",
      },
      error: { fontSize: "12px", color: "var(--dsw-alias-state-error-primary, #e5534b)", margin: 0 },
      ok: { fontSize: "12px", color: "var(--dsw-alias-state-success-primary, #3fb950)", margin: 0 },
      deviceList: { display: "flex", flexDirection: "column", gap: "6px", borderTop: "0.5px solid var(--dsw-alias-border-l2, #30363d)", paddingTop: "12px" },
      device: { display: "flex", flexDirection: "column", gap: "2px" },
      deviceName: { fontSize: "13px", color: "var(--dsw-alias-label-primary, #e6edf3)" },
      deviceMeta: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #8b949e)", fontFamily: "var(--dsw-font-markdown-code-font-family, monospace)" },
    };

    /** A checkbox rendered as a small switch; the platform has no shared one here. */
    function Switch({ checked, disabled, onChange, label }) {
      return h(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": checked ? "true" : "false",
          "aria-label": label,
          disabled: disabled === true,
          onClick: () => onChange(!checked),
          style: {
            width: "36px",
            height: "20px",
            borderRadius: "10px",
            border: "none",
            padding: 0,
            cursor: disabled ? "default" : "pointer",
            background: checked ? "var(--dsw-alias-brand-primary, #2f81f7)" : "var(--dsw-alias-border-l4, #484f58)",
            position: "relative",
            flexShrink: 0,
            opacity: disabled ? 0.6 : 1,
            transition: "background 120ms ease",
          },
        },
        h("span", {
          "aria-hidden": "true",
          style: {
            position: "absolute",
            top: "2px",
            left: checked ? "18px" : "2px",
            width: "16px",
            height: "16px",
            borderRadius: "50%",
            background: "var(--dsw-alias-label-primary-foreground, #ffffff)",
            transition: "left 120ms ease",
          },
        }),
      );
    }

    /** The Cindy sign-in form; shown only while the Host reports it needs one. */
    function LoginForm({ busy, error, notice, accounts, onSendCode, onSignIn, onSelectAccount }) {
      const [kind, setKind] = react.useState("phone");
      const [identifier, setIdentifier] = react.useState("");
      const [code, setCode] = react.useState("");

      const identifierLabel = kind === "phone" ? TEXT.identifierPhone : TEXT.identifierEmail;

      return h(
        "div",
        { style: styles.form },
        h("span", { style: styles.label }, TEXT.loginTitle),
        h("span", { style: styles.hint }, TEXT.loginHint),
        h(
          "div",
          { style: styles.field },
          h("span", { style: styles.hint }, TEXT.kindPhone + " / " + TEXT.kindEmail),
          h(
            "div",
            { style: { display: "flex", gap: "6px" } },
            ["phone", "email"].map((value) =>
              h(
                "button",
                {
                  key: value,
                  type: "button",
                  onClick: () => setKind(value),
                  style: Object.assign({}, styles.buttonGhost, {
                    flex: 1,
                    color: kind === value ? "var(--dsw-alias-label-primary, #e6edf3)" : undefined,
                    borderColor: kind === value ? "var(--dsw-alias-brand-primary, #2f81f7)" : undefined,
                  }),
                },
                value === "phone" ? TEXT.kindPhone : TEXT.kindEmail,
              ),
            ),
          ),
        ),
        h(
          "label",
          { style: styles.field },
          h("span", { style: styles.hint }, identifierLabel),
          h("input", {
            style: styles.input,
            value: identifier,
            inputMode: kind === "phone" ? "tel" : "email",
            autoComplete: kind === "phone" ? "tel" : "email",
            onChange: (event) => setIdentifier(event.target.value),
            disabled: busy,
          }),
        ),
        h(
          "div",
          { style: { display: "flex", gap: "6px", alignItems: "flex-end" } },
          h(
            "label",
            { style: Object.assign({}, styles.field, { flex: 1 }) },
            h("span", { style: styles.hint }, TEXT.code),
            h("input", {
              style: styles.input,
              value: code,
              inputMode: "numeric",
              autoComplete: "one-time-code",
              onChange: (event) => setCode(event.target.value),
              disabled: busy,
            }),
          ),
          h(
            "button",
            {
              type: "button",
              style: Object.assign({}, styles.buttonGhost, { height: "32px" }),
              disabled: busy,
              onClick: () => onSendCode({ kind, identifier }),
            },
            busy ? TEXT.sending : TEXT.sendCode,
          ),
        ),
        accounts && accounts.length > 0
          ? h(
              "div",
              { style: styles.field },
              h("span", { style: styles.hint }, TEXT.selectAccount),
              accounts.map((account) =>
                h(
                  "button",
                  { key: account.id, type: "button", style: styles.buttonGhost, disabled: busy, onClick: () => onSelectAccount(account.id) },
                  account.displayName || account.id,
                ),
              ),
            )
          : null,
        error ? h("p", { style: styles.error }, error) : null,
        notice ? h("p", { style: styles.ok }, notice) : null,
        h(
          "button",
          { type: "button", style: styles.button, disabled: busy, onClick: () => onSignIn({ kind, identifier, code }) },
          busy ? TEXT.signingIn : TEXT.signIn,
        ),
      );
    }

    /** One device row: a name the user recognizes plus the id they can quote. */
    function DeviceRow({ device }) {
      const online = device.online === true;
      return h(
        "div",
        { style: styles.device },
        h("span", { style: styles.deviceName }, device.name || device.deviceId),
        h(
          "span",
          { style: styles.deviceMeta },
          (online ? TEXT.deviceOnline : TEXT.deviceOffline) + " · " + platformText(device.platform) + " · " + device.deviceId,
        ),
      );
    }

    /**
     * Build the card bound to one settings scope.
     * @param scope - the bound `dsh-cindy-host` settings scope.
     * @returns the React component the slot renders.
     */
    /**
     * Build the settings page bound to one settings scope.
     * @param scope - the bound `dsh-cindy-host` settings scope.
     * @returns the React component the settings section renders.
     */
    function createCindySettingsPage(scope) {
      return function CindyHostSettingsPage() {
        const subscribe = react.useCallback((listener) => scope.subscribe(listener), [scope]);
        const getSnapshot = react.useCallback(() => scope.getSnapshot(), [scope]);
        const scopeSnapshot = react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

        const [status, setStatus] = react.useState(null);
        const [statusError, setStatusError] = react.useState(false);
        const [refreshKey, setRefreshKey] = react.useState(0);
        const [busy, setBusy] = react.useState(false);
        const [error, setError] = react.useState(null);
        const [notice, setNotice] = react.useState(null);
        const [accounts, setAccounts] = react.useState(null);
        const [loginTicket, setLoginTicket] = react.useState(null);

        const refresh = react.useCallback(() => setRefreshKey((value) => value + 1), []);

        react.useEffect(() => {
          let alive = true;
          const tick = async () => {
            try {
              const response = await fetch(API + "/status", { headers: { accept: "application/json" } });
              const body = await response.json();
              if (!alive) return;
              setStatus(body && body.status ? body.status : null);
              setStatusError(false);
            } catch {
              if (alive) setStatusError(true);
            }
          };
          void tick();
          const timer = setInterval(tick, POLL_MS);
          return () => {
            alive = false;
            clearInterval(timer);
          };
        }, [refreshKey]);

        const setSwitch = react.useCallback(
          async (next) => {
            setError(null);
            try {
              await writeSwitch(scope, next);
            } catch {
              setError("写入设置失败，请重试");
            }
            refresh();
          },
          [scope, refresh],
        );

        const guard = react.useCallback(async (work) => {
          setBusy(true);
          setError(null);
          try {
            await work();
          } catch {
            setError("请求失败，请重试");
          } finally {
            setBusy(false);
            refresh();
          }
        }, [refresh]);

        const onSendCode = ({ kind, identifier }) =>
          guard(async () => {
            setNotice(null);
            const result = await postJson("/login/request-code", { kind, identifier });
            if (!result.ok) {
              setError(result.message || "验证码发送失败");
              return;
            }
            setNotice(TEXT.codeSent);
          });

        const onSignIn = ({ kind, identifier, code }) =>
          guard(async () => {
            setNotice(null);
            setAccounts(null);
            const result = await postJson("/login/verify-code", { kind, identifier, code });
            if (!result.ok) {
              if (result.status === "select_account" && Array.isArray(result.accounts)) {
                setAccounts(result.accounts);
                setLoginTicket(result.loginTicket);
              }
              setError(result.message || "登录失败");
              return;
            }
            setNotice(null);
          });

        const onSelectAccount = (accountId) =>
          guard(async () => {
            const result = await postJson("/login/select-account", { loginTicket, accountId });
            if (!result.ok) {
              setError(result.message || "账户选择失败");
              return;
            }
            setAccounts(null);
          });

        const onReconnect = () => guard(async () => {
          const result = await postJson("/reconnect", {});
          if (!result.ok) setError(result.message || "重新连接失败");
        });

        const onLogout = () => guard(async () => {
          const result = await postJson("/logout", {});
          if (!result.ok) setError(result.message || "退出登录失败");
        });

        const view = resolveCardView(status, scopeSnapshot);

        if (view.unavailable) {
          return h("div", { style: styles.page }, h("p", { style: styles.hint }, TEXT.unavailable));
        }

        return h(
          "div",
          { style: styles.page },
          h(
            "div",
            { style: styles.header },
            h("span", { style: styles.title }, TEXT.title),
            h("p", { style: styles.description }, TEXT.description),
          ),

          h(
            "div",
            { style: styles.row },
            h(
              "div",
              { style: styles.rowText },
              h("span", { style: styles.label }, TEXT.switchLabel),
              h("span", { style: styles.hint }, TEXT.switchHint),
            ),
            h(Switch, { checked: view.switchOn, disabled: !view.writable || busy, onChange: (next) => void setSwitch(next), label: TEXT.switchLabel }),
          ),

          h(
            "div",
            { style: styles.statusRow },
            h("span", { "aria-hidden": "true", style: Object.assign({}, styles.dot, { background: stateColor(view.state) }) }),
            h("span", null, view.stateLabel),
            view.message ? h("span", { style: styles.hint }, "· " + view.message) : null,
          ),

          statusError ? h("p", { style: styles.hint }, TEXT.statusUnavailable) : null,

          view.showLogin ? h(LoginForm, { busy, error, notice, accounts, onSendCode, onSignIn, onSelectAccount }) : null,

          view.showReconnect
            ? h(
                "div",
                { style: { display: "flex", gap: "6px" } },
                h("button", { type: "button", style: styles.buttonGhost, disabled: busy, onClick: onReconnect }, TEXT.reconnect),
                view.login.authenticated ? h("button", { type: "button", style: styles.buttonGhost, disabled: busy, onClick: onLogout }, TEXT.logout) : null,
              )
            : null,

          error && !view.showLogin ? h("p", { style: styles.error }, error) : null,

          h(
            "div",
            { style: styles.deviceList },
            h("span", { style: styles.label }, TEXT.devices),
            view.devices.length > 0 ? view.devices.map((device) => h(DeviceRow, { key: device.deviceId, device })) : h("span", { style: styles.hint }, TEXT.noDevices),
            view.host && view.host.deviceId
              ? h(
                  "span",
                  { style: styles.deviceMeta },
                  TEXT.hostDevice + ": " + (view.host.deviceName || "DSH Host") + " · " + view.host.deviceId,
                )
              : null,
          ),
        );
      };
    }

    const inject = ["slots", "settingsScope"];

    /** Nav position: general=0, models=10, plugins=15, agent-presets=20. */
    const SECTION_ORDER = 25;

    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
      const Page = createCindySettingsPage(scope);
      // `slots.inject`, not a bare `slots.register`: the settings shell declares
      // `settings.section` when ui-settings-general activates, and this bundle
      // may activate before it does. Registering eagerly throws
      // `slot "settings.section" is not declared`; injecting defers the
      // registration until the declaring parent publishes the slot — which is
      // how the shipped sections (general/models/plugins) register too.
      //
      // A dedicated page rather than a `settings.plugin.item` card: this surface
      // owns a connection switch, a sign-in flow and a device list, which is a
      // page's worth of state, and the Plugins tab is for a plugin's preferences.
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            // `id` is the section key the nav and `only` filtering use; it must
            // be the settings namespace so the page and its Host half line up.
            id: NAMESPACE,
            order: SECTION_ORDER,
            // The shell reads this on every render, so it stays a fresh function
            // over the current locale rather than a frozen string.
            label: () => TEXT.title,
          },
          Page,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    // Test seam: the presentation helpers and sub-components, so the markup
    // rules can be rendered and asserted without a browser. Not part of the
    // plugin contract — the runner reads only `apply` and `inject`.
    exports.__internals = { TEXT, NAMESPACE, API, SECTION_ORDER, resolveCardView, stateText, stateColor, platformText, writeSwitch, Switch, LoginForm, DeviceRow, createCindySettingsPage };
    return module.exports;
  },
});
