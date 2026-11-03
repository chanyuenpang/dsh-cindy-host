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
  id: "dsh-cindy-host",
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
          switchDisabled: "手机连接已关闭；打开开关后才能连接。",
          signedIn: "已登录 Cindy",
          stateDisconnected: "未连接",
          stateAuthenticating: "登录中",
          stateConnecting: "正在重连",
          stateWaiting: "等待手机连接",
          stateConnected: "已连接",
          stateFailed: "连接失败",
          reconnect: "重新连接",
          loginTitle: "登录 Cindy",
          loginHint: "请选择与手机相同的账号和区域；国内版与国际版账户不互通。",
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
          devices: "账号设备",
          deviceOffline: "离线",
          deviceOnline: "在线",
          unknownPlatform: "未知平台",
          hostDevice: "本机设备",
          hostName: "主机名称",
          hostNameHint: "用于 Cindy 设备列表，最多 64 个字符，不影响系统计算机名或设备连接。",
          saveName: "保存名称",
          savingName: "保存中…",
          nameSaved: "主机名称已保存到本机。",
          nameSaveFailed: "保存失败，请重试",
          nameInvalid: "请输入 1–64 个字符，不能包含换行或控制字符",
          nameSyncPending: "连接 Cindy 后会同步名称。",
          nameSyncing: "正在同步到 Cindy…",
          nameSynced: "名称已同步到 Cindy。",
          nameSyncFailed: "本机名称已保存，但 Cindy 同步失败；请检查网络或登录状态，重新开关连接后重试。",
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
          switchDisabled: "Phone connection is disabled; turn on the switch to connect.",
          signedIn: "Signed in to Cindy",
          stateDisconnected: "Not connected",
          stateAuthenticating: "Signing in",
          stateConnecting: "Reconnecting",
          stateWaiting: "Waiting for phone",
          stateConnected: "Connected",
          stateFailed: "Connection failed",
          reconnect: "Reconnect",
          loginTitle: "Sign in to Cindy",
          loginHint: "Use the same account AND region as your phone. Mainland and Global accounts are separate.",
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
          devices: "Account devices",
          deviceOffline: "offline",
          deviceOnline: "online",
          unknownPlatform: "unknown platform",
          hostDevice: "This Host",
          hostName: "Host name",
          hostNameHint: "Shown in Cindy. Up to 64 characters; does not change your computer name or device identity.",
          saveName: "Save name",
          savingName: "Saving…",
          nameSaved: "Host name saved locally.",
          nameSaveFailed: "Could not save. Please try again.",
          nameInvalid: "Enter 1–64 characters without line breaks or control characters.",
          nameSyncPending: "The name will sync when connected to Cindy.",
          nameSyncing: "Syncing to Cindy…",
          nameSynced: "Name synced to Cindy.",
          nameSyncFailed: "Saved locally, but Cindy sync failed. Check your network or sign-in, then turn the connection off and on to retry.",
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
     * Derive everything the page draws from the two inputs it is allowed to trust:
     * the Host status and the settings snapshot. Pure, so the markup rules are
     * testable without a browser.
     * @param status - last status the Host answered, or null before the first poll.
     * @param snapshot - the {@link settingsSnapshot} the page last built.
     * @returns the view model the page renders.
     */
    function resolveCardView(status, snapshot) {
      const value = (snapshot && snapshot.value) || {};
      const login = (status && status.login) || { authenticated: false, required: false };
      return {
        switchOn: value.transportEnabled === true || value.remoteControlEnabled === true,
        writable: !!snapshot && snapshot.status === "ready" && snapshot.writable !== false,
        unavailable: !!snapshot && snapshot.status === "unavailable",
        state: status ? status.state : "disconnected",
        stateLabel: stateText(status && status.state, status && status.stateLabel),
        message: (status && status.message) || null,
        devices: status && Array.isArray(status.devices) ? status.devices : [],
        login,
        host: (status && status.host) || null,
        deviceName: typeof value.deviceName === "string" && value.deviceName.trim() ? value.deviceName.trim() : "DSH Host",
        showLogin: login.authenticated !== true,
        showReconnect: (status ? status.state : "disconnected") === "failed" && login.required !== true,
      };
    }

    /**
     * Move the phone switch through the settings controller.
     *
     * Both spellings move together: `transportEnabled` is the card's own field,
     * `remoteControlEnabled` is what a hand-edited document or the CLI path uses
     * for the same intent. The Host reads the union, so leaving one behind would
     * make the switch disagree with the socket.
     *
     * The controller comes from {@link resolveSettingsController}: it is a
     * `settingsScope` scope on 0.1.x and a `configForms` controller on 0.2, and both
     * expose `set(field, value)` over the same Host settings document. Prefer
     * `mutate(ops)` when available so both flags commit atomically.
     * @param scope - the bound settings controller for this namespace.
     * @param next - the requested switch position.
     */
    async function writeSwitch(scope, next) {
      const fields = ["transportEnabled", "remoteControlEnabled"];
      if (typeof scope.mutate === "function") {
        const accepted = await scope.mutate(fields.map((field) => ({ op: "set", path: [field], value: next })));
        if (accepted === false) throw new Error("Settings write rejected");
        return;
      }
      // Older scopes return void on success; only an explicit false is rejection.
      for (const field of fields) {
        if (await scope.set(field, next) === false) throw new Error("Settings write rejected");
      }
    }

    /** Read a real status snapshot; API failures must not become 'disconnected'. */
    async function readStatus() {
      const response = await fetch(API + "/status", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(TEXT.statusUnavailable);
      const body = await response.json();
      if (!body || body.ok === false || !body.status || typeof body.status !== "object" ||
          Array.isArray(body.status) || typeof body.status.state !== "string" || !body.status.state) {
        throw new Error(TEXT.statusUnavailable);
      }
      return body.status;
    }

    /** Only expose a small recognizable fragment of the authenticated identifier. */
    function maskIdentifier(identifier) {
      if (typeof identifier !== "string" || !identifier.trim()) return null;
      const value = identifier.trim();
      const at = value.indexOf("@");
      if (at > 0) return value[0] + "***@" + value.slice(at + 1);
      return value.length > 4 ? "***" + value.slice(-4) : "***";
    }

    function validHostName(value) {
      return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
    }

    async function writeHostName(scope, value) {
      if (!validHostName(value)) throw new Error(TEXT.nameInvalid);
      if (await scope.set("deviceName", value.trim()) === false) throw new Error(TEXT.nameSaveFailed);
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

    const tr = (zh, en) => ZH ? zh : en;
    function loginError(code) {
      const messages = {
        LOGIN_BUSY: tr("其他页面正在登录，可取消后重新开始。", "Another page is signing in. Cancel it explicitly to restart."),
        LOGIN_STEP_CHANGED: tr("登录步骤已更新，请重试当前操作。", "The login step changed. Retry the current action."),
        LOGIN_SUPERSEDED: tr("这次登录已取消或被替换，请重新开始。", "This sign-in was cancelled or replaced. Start again."),
        ORG_REALM_UNAVAILABLE: tr("无法完整确认企业所在区域，请检查国内/国际网络后重试。", "Cannot verify both regions. Check connectivity and retry."),
        ORG_REALM_AMBIGUOUS: tr("两个区域都有同名企业，不能自动选择，请联系管理员。", "The organization exists in both regions. Contact its administrator."),
        ORG_SSO_NOT_FOUND: tr("未找到已启用 SSO 的企业，请检查组织 ID 或域名。", "No SSO-enabled organization found. Check its ID or domain."),
        INVALID_CAPTCHA_RESULT: tr("请粘贴官方验证页成功后的完整地址栏链接。", "Paste the complete successful verification URL from the official page."),
        LOGIN_COMMITTING: tr("登录正在安全保存，请等待完成。", "Sign-in is being saved securely. Please wait."),
        REQUEST_TIMEOUT: tr("登录请求已超时，请重新开始。", "Sign-in timed out. Please start again."),
        LOGIN_EXPIRED: tr("这次登录已过期，请重新开始。", "This sign-in expired. Please start again."),
      };
      return messages[code] || tr("登录未完成，请检查输入或网络后重试", "Sign-in did not complete. Check your input or network and retry") + (code && /^[A-Z0-9_]{1,80}$/.test(code) ? " (" + code + ")" : "");
    }
    function safeLoginUrl(value, region) {
      try {
        const url = new URL(value);
        const domain = region === "global" ? "cindy.app" : "cindy.com.cn";
        return url.protocol === "https:" && !url.username && !url.password && !url.port &&
          (url.hostname === domain || url.hostname.endsWith("." + domain)) ? url.href : null;
      } catch { return null; }
    }
    /** Pure renderer. Attempt IDs/revisions are capabilities; all backend tickets stay off-page. */
    function LoginForm({ flow = null, fields = {}, onField = () => {}, onAction = () => {}, onStart = () => {}, busy = false, error = null }) {
      const region = flow?.region || fields.region || "cn";
      const step = flow?.step;
      const disabled = busy || flow?.busy === true;
      const providers = flow?.providers;
      const kind = providers?.[fields.kind] ? fields.kind : providers?.phone ? "phone" : "email";
      const button = (label, action, data = {}, off = disabled) => h("button", { key: action + JSON.stringify(data), type: "button", style: styles.buttonGhost, disabled: off,
        onClick: () => onAction(action, data) }, label);
      const input = (name, label, mode = "text", maxLength = 254) => h("label", { style: styles.field }, h("span", { style: styles.hint }, label),
        h("input", { style: styles.input, value: fields[name] || "", inputMode: mode, maxLength,
          autoComplete: name === "code" ? "one-time-code" : name === "identifier" ? kind === "phone" ? "tel" : "email" : "off",
          disabled, onChange: event => onField(name, event.target.value) }));
      const link = (url, label) => url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer", referrerPolicy: "no-referrer", style: styles.buttonGhost }, label) : null;
      let body;
      if (!flow) body = h("div", { style: styles.field },
        h("label", { style: styles.field }, tr("账号区域", "Account region"), h("select", { style: styles.input, value: region, disabled,
          onChange: event => onField("region", event.target.value) }, h("option", { value: "cn" }, tr("国内版", "Mainland China")), h("option", { value: "global" }, tr("国际版", "Global")))),
        h("button", { type: "button", style: styles.button, disabled, onClick: () => onStart(region, false) }, tr("加载登录方式", "Load sign-in options")));
      else if (step === "identifier") body = h("div", { style: styles.field },
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px" } }, (providers?.social || []).map(provider => button(
          ({ apple: tr("通过 Apple 登录", "Sign in with Apple"), google: "Google", wechat: tr("微信登录", "WeChat") })[provider] || provider,
          "start_browser", { kind: "social", providerOrConnectionId: provider }))),
        providers && (providers.phone || providers.email) ? h("div", { style: styles.field },
          h("div", { style: { display: "flex", gap: "8px" } }, ["phone", "email"].filter(value => providers[value]).map(value =>
            h("button", { key: value, type: "button", disabled, style: styles.buttonGhost, "aria-pressed": kind === value,
              onClick: () => onField("kind", value) }, value === "phone" ? TEXT.kindPhone : TEXT.kindEmail))),
          input("identifier", kind === "phone" ? TEXT.identifierPhone : TEXT.identifierEmail, kind === "phone" ? "tel" : "email"),
          button(kind === "email" ? tr("继续（检测邮箱登录方式）", "Continue (discover email sign-in)") : TEXT.sendCode,
            kind === "email" ? "discover_email" : "request_code", { kind, identifier: fields.identifier || "" })) : null,
        input("org", tr("企业组织 ID / slug / 已验证域名", "Organization ID / slug / verified domain")),
        button(tr("企业 SSO 登录", "Enterprise SSO"), "discover_org", { org: fields.org || "" }));
      else if (step === "method-choice") body = h("div", { style: styles.field }, (flow.methods || []).map(method =>
        method.type === "sso" ? button((method.orgName || "") + " · " + (method.connectionName || "SSO"), "start_browser", { kind: "sso", providerOrConnectionId: method.connectionId })
          : button(tr("使用个人邮箱验证码（保留原区域）", "Use personal email code (keep original region)"), "personal_email")));
      else if (step === "region-confirmation") body = h("div", { style: styles.field },
        h("p", { style: styles.hint }, tr("企业位于", "This organization is in ") + (flow.targetRegion === "global" ? tr("国际区", "Global") : tr("国内区", "Mainland China")) + tr("，确认切换后继续。", ". Confirm the region change to continue.")),
        button(tr("确认切换区域", "Confirm region change"), "confirm_region"));
      else if (step === "browser") body = h("div", { style: styles.field },
        h("p", { style: styles.hint, role: "status" }, tr("请在官方页面完成登录。本页会自动接收结果；5 分钟内有效。", "Complete sign-in on the official page. This page receives the result automatically; valid for 5 minutes.")),
        link(safeLoginUrl(flow.authorizationUrl, region), tr("打开 Cindy 官方登录页面", "Open official Cindy sign-in")));
      else if (step === "account-selection") body = h("div", { style: styles.field }, h("span", { style: styles.label }, TEXT.selectAccount),
        (flow.accounts || []).map(account => button((account.displayName || account.id) + (account.orgName ? " · " + account.orgName : ""), "select_account", { accountId: account.id })));
      else if (step === "captcha") body = h("div", { style: styles.field },
        h("p", { style: styles.hint }, tr("请在官方页面完成人机验证，再复制成功页的完整地址栏链接（含 #cindy-captcha=ok.…）粘贴到下方。浏览器安全限制使本页无法自动读取该链接。请勿分享它。", "Complete verification on the official page, then copy its complete URL (including #cindy-captcha=ok.…) below. Browser security prevents automatic return. Do not share this URL.")),
        link(safeLoginUrl(flow.challengeUrl, region), tr("打开官方人机验证", "Open official verification")),
        input("captchaResult", tr("验证成功后的完整链接", "Complete successful verification URL"), "url", 12000),
        button(TEXT.sendCode, "captcha_complete", { resultUrl: fields.captchaResult || "" }));
      else if (step === "binding") body = h("div", { style: styles.field },
        h("p", { style: styles.hint }, tr("此账号需要先绑定联系方式。", "This account requires a verified contact.")),
        input("binding", flow.bindType === "phone" ? TEXT.identifierPhone : TEXT.identifierEmail, flow.bindType === "phone" ? "tel" : "email"),
        button(TEXT.sendCode, "binding_request", { identifier: fields.binding || "" }), input("code", TEXT.code, "numeric", 100),
        button(tr("验证并绑定", "Verify and bind"), "binding_verify", { identifier: fields.binding || "", code: fields.code || "" }));
      else if (step === "sso-verification") body = h("div", { style: styles.field },
        h("p", { style: styles.hint }, tr("企业 SSO 需要额外验证：", "Enterprise SSO needs additional verification: ") + (flow.targetMasked || "")),
        button(TEXT.sendCode, "sso_request"), input("code", TEXT.code, "numeric", 100), button(TEXT.signIn, "sso_verify", { code: fields.code || "" }));
      else if (step === "verification-code") body = h("div", { style: styles.field }, h("p", { style: styles.hint }, TEXT.codeSent + " · " + (flow.targetMasked || "")),
        input("code", TEXT.code, "numeric", 100), button(TEXT.signIn, "verify_code", { code: fields.code || "" }),
        button(tr("重新发送验证码", "Resend code"), "request_code", { kind: flow.kind, identifier: fields.identifier || "" }));
      else body = h("p", { style: styles.hint, role: "status" }, step === "completed" ? TEXT.signedIn : step === "committing" ? tr("正在安全保存登录…", "Saving sign-in securely…") : tr("请重新开始登录。", "Please start sign-in again."));
      return h("div", { style: styles.form }, h("span", { style: styles.label }, TEXT.loginTitle), h("span", { style: styles.hint }, TEXT.loginHint),
        flow ? h("p", { style: styles.hint }, tr("账号区域：", "Account region: ") + (region === "global" ? tr("国际版", "Global") : tr("国内版", "Mainland China"))) : null,
        body, (error || flow?.error) ? h("p", { style: styles.error, role: "alert" }, error || loginError(flow.error)) : null,
        error === loginError("LOGIN_BUSY") ? h("button", { type: "button", style: styles.buttonGhost, disabled,
          onClick: () => onStart(region, true) }, tr("取消其他登录并重新开始", "Cancel other sign-in and restart")) : null,
        flow && !["completed", "committing", "cancelled", "error"].includes(step) ? button(tr("取消这次登录", "Cancel this sign-in"), "cancel", {}, false) : null,
        flow && step !== "committing" ? h("div", { style: { display: "flex", gap: "8px" } },
          h("button", { type: "button", style: styles.buttonGhost, disabled, onClick: () => onStart(region, true) }, tr("重新开始", "Start again")),
          h("button", { type: "button", style: styles.buttonGhost, disabled, onClick: () => onStart(region === "cn" ? "global" : "cn", true) }, tr("切换国内 / 国际区域", "Switch Mainland / Global"))) : null);
    }
    function AuthLoginPanel({ onAuthenticated }) {
      const [flow, setFlow] = react.useState(null);
      const [fields, setFields] = react.useState({ region: "cn", kind: "phone" });
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);
      const state = react.useRef({ flow: null, generation: 0, alive: true, busy: false, polling: false });
      const apply = (result, generation) => {
        if (!state.current.alive || generation !== state.current.generation) return;
        const next = result.view;
        if (next && (!state.current.flow || next.attemptId !== state.current.flow.attemptId || next.revision >= state.current.flow.revision)) {
          const previous = state.current.flow; state.current.flow = next; setFlow(next);
          if (previous?.step !== next.step) setFields(value => ({ ...value, code: "", captchaResult: "" }));
          if (next.step === "completed" && previous?.step !== "completed") onAuthenticated?.();
        }
        if (!result.ok) setError(loginError(result.code));
      };
      const act = async (action, data = {}) => {
        const read = action === "read";
        if (!read && action !== "cancel" && state.current.busy) return;
        if (read && state.current.polling) return;
        if (read) state.current.polling = true;
        else { state.current.busy = true; setBusy(true); setError(null); }
        const generation = action === "cancel" ? ++state.current.generation : state.current.generation;
        const current = state.current.flow;
        try { apply(await postJson("/login/flow", { action, attemptId: current?.attemptId, revision: current?.revision, ...data }), generation); }
        catch { if (state.current.alive && generation === state.current.generation) setError(tr("请求失败，请重试", "Request failed. Please retry.")); }
        finally { if (read) state.current.polling = false; else if (generation === state.current.generation) { state.current.busy = false; if (state.current.alive) setBusy(false); } }
      };
      const start = async (region, takeover) => {
        if (state.current.busy) return;
        const generation = ++state.current.generation; state.current.busy = true; setBusy(true); setError(null);
        try {
          const prior = state.current.flow;
          if (prior && !["completed", "cancelled", "error"].includes(prior.step)) {
            const cancelled = await postJson("/login/flow", { action: "cancel", attemptId: prior.attemptId });
            if (!cancelled.ok) { apply(cancelled, generation); return; }
          }
          state.current.flow = null; setFlow(null); setFields({ region, kind: region === "cn" ? "phone" : "email" });
          apply(await postJson("/login/flow", { action: "start", region, takeover }), generation);
        } catch { if (state.current.alive && generation === state.current.generation) setError(tr("读取登录方式失败，请检查网络后重试", "Cannot load sign-in options. Check your connection and retry.")); }
        finally { if (generation === state.current.generation) { state.current.busy = false; if (state.current.alive) setBusy(false); } }
      };
      react.useEffect(() => {
        state.current.alive = true;
        return () => {
          state.current.alive = false; state.current.generation++;
          const current = state.current.flow;
          if (current && !["completed", "cancelled", "error"].includes(current.step)) void postJson("/login/flow", { action: "cancel", attemptId: current.attemptId }).catch(() => {});
        };
      }, []);
      react.useEffect(() => {
        if (!flow || !["browser", "committing"].includes(flow.step)) return;
        const timer = setInterval(() => { void act("read"); }, POLL_MS);
        return () => clearInterval(timer);
      }, [flow?.attemptId, flow?.step]);
      return h(LoginForm, { flow, fields, busy, error, onField: (name, value) => setFields(old => ({ ...old, [name]: value })), onAction: act, onStart: start });
    }

    /** Keep an unsaved draft independent of status polling and settings snapshots. */
    function HostNameForm({ scope, value, writable, busy = false, sync }) {
      const [draft, setDraft] = react.useState(null);
      const [saving, setSaving] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [saved, setSaved] = react.useState(false);
      const savingRef = react.useRef(false);
      const text = draft === null ? value : draft;
      const valid = validHostName(text);
      const disabled = !writable || busy || saving;
      const save = async (event) => {
        event.preventDefault();
        if (disabled || savingRef.current || !valid || text.trim() === value) return;
        savingRef.current = true;
        setSaving(true);
        setError(null);
        setSaved(false);
        try {
          await writeHostName(scope, text);
          setDraft(null);
          setSaved(true);
        } catch { setError(TEXT.nameSaveFailed); }
        finally { savingRef.current = false; setSaving(false); }
      };
      const syncText = sync?.name === value ? {
        pending: TEXT.nameSyncPending, syncing: TEXT.nameSyncing,
        synced: TEXT.nameSynced, failed: TEXT.nameSyncFailed,
      }[sync.state] : null;
      return h("form", { style: styles.form, onSubmit: save },
        h("label", { style: styles.field },
          h("span", { style: styles.label }, TEXT.hostName),
          h("input", { style: Object.assign({}, styles.input, { minWidth: 0 }),
            value: text, maxLength: 64, disabled,
            onChange: (event) => { setDraft(event.target.value); setSaved(false); setError(null); },
          }),
        ),
        h("span", { style: styles.hint }, TEXT.hostNameHint),
        draft !== null && !valid ? h("p", { style: styles.error, role: "alert" }, TEXT.nameInvalid) : null,
        h("button", { type: "submit", style: Object.assign({}, styles.buttonGhost, { alignSelf: "flex-start" }),
          disabled: disabled || !valid || text.trim() === value }, saving ? TEXT.savingName : TEXT.saveName),
        error ? h("p", { style: styles.error, role: "alert" }, error) : null,
        saved ? h("p", { style: styles.ok, role: "status" }, TEXT.nameSaved) : null,
        syncText ? h("p", { style: sync.state === "failed" ? styles.error : styles.hint, role: "status" }, syncText) : null,
      );
    }

    /** One device row: a name the user recognizes plus the id they can quote. */
    function DeviceRow({ device, onDelete, busy = false }) {
      const [confirming, setConfirming] = react.useState(false);
      const online = device.online === true;
      return h(
        "div",
        { style: styles.device },
        h("span", { style: styles.deviceName }, device.name || device.deviceId),
        h(
          "span",
          { style: styles.deviceMeta },
          (online ? TEXT.deviceOnline : TEXT.deviceOffline) + " · " + platformText(device.platform) + " · " + device.deviceId + (device.lastSeenAt ? " · " + device.lastSeenAt : ""),
        ),
        onDelete ? h("div", null,
          confirming && device.online === false ? h("div", null,
            h("span", { style: styles.hint }, "从账号中删除此设备？这会移除该设备记录，并非仅隐藏。"),
            h("button", { type: "button", disabled: busy, onClick: () => onDelete(device.deviceId) }, "确认删除"),
            h("button", { type: "button", disabled: busy, onClick: () => setConfirming(false) }, "取消"),
          ) : h("button", { type: "button", disabled: busy || device.online !== false, title: online ? "在线设备不能删除，请先断开" : "删除离线设备", onClick: () => setConfirming(true) }, "删除设备"),
        ) : null,
      );
    }

    /**
     * Build the settings page bound to one settings controller.
     * @param scope - the bound controller for this namespace (see {@link writeSwitch}).
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

        const refresh = react.useCallback(() => setRefreshKey((value) => value + 1), []);

        react.useEffect(() => {
          let alive = true;
          const tick = async () => {
            try {
              const nextStatus = await readStatus();
              if (!alive) return;
              setStatus(nextStatus);
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

        const onDeleteDevice = (deviceId) => guard(async () => {
          const result = await postJson("/devices/delete", { deviceId });
          if (!result.ok) { setError(result.message || "删除失败，请刷新重试"); return; }
          if (result.status) setStatus(result.status);
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

          scopeSnapshot.status === "ready" && !view.switchOn
            ? h("p", { style: styles.hint }, TEXT.switchDisabled)
            : null,

          statusError
            ? h("p", { role: "status", style: styles.hint }, TEXT.statusUnavailable)
            : h(
                "div",
                { style: styles.statusRow },
                h("span", { "aria-hidden": "true", style: Object.assign({}, styles.dot, { background: stateColor(view.state) }) }),
                h("span", null, view.stateLabel),
                view.message ? h("span", { style: styles.hint }, "· " + view.message) : null,
              ),

          h(HostNameForm, { scope, value: view.deviceName, writable: view.writable, busy, sync: status && status.nameSync }),

          view.login.authenticated === true
            ? h(
                "div",
                { style: styles.row },
                h("span", { style: styles.hint }, TEXT.signedIn + (view.login.realm ? ' · ' + (view.login.realm === 'global' ? tr('国际版', 'Global') : tr('国内版', 'Mainland China')) : '') + (maskIdentifier(view.login.identifier) ? " · " + maskIdentifier(view.login.identifier) : "")),
                h("button", { type: "button", style: styles.buttonGhost, disabled: busy, onClick: onLogout }, TEXT.logout),
              )
            : null,

          view.showLogin ? h(AuthLoginPanel, { onAuthenticated: refresh }) : null,

          view.showReconnect
            ? h(
                "div",
                { style: { display: "flex", gap: "6px" } },
                h("button", { type: "button", style: styles.buttonGhost, disabled: busy, onClick: onReconnect }, TEXT.reconnect),
              )
            : null,

          error ? h("p", { style: styles.error }, error) : null,

          h(
            "div",
            { style: styles.deviceList },
            h("span", { style: styles.label }, TEXT.devices),
            view.devices.length > 0 ? view.devices.map((device) => h(DeviceRow, { key: device.deviceId, device, busy, onDelete: view.login.authenticated && device.deviceId !== view.host?.deviceId ? onDeleteDevice : null })) : h("span", { style: styles.hint }, TEXT.noDevices),
            view.host && view.host.deviceId
              ? h(
                  "span",
                  { style: styles.deviceMeta },
                  TEXT.hostDevice + ": " + (view.host.deviceName || "DSH Host") + " · " + view.host.deviceId + (view.host.appVersion ? " · Cindy " + view.host.appVersion : ""),
                )
              : null,
          ),
        );
      };
    }

    /**
     * Services this half needs a provider **for before it may activate**.
     *
     * `slots` only, and that is the whole fix: a module-level `inject` entry is a
     * *blocking* dependency, so listing a service the running DSH does not provide
     * keeps this half permanently pending — it never activates, and 0.2 reports the
     * entry as the reason it refuses to finish starting.
     *
     * It used to be `["slots", "settingsScope"]`, and the settings service changed
     * name between generations:
     *
     * - `0.1.5-rc.2` provides **`settingsScope`** (`dsh-client-ui-settings` client half
     *   `super(ctx, "settingsScope")`), whose `bind({ namespace })` returns a scope.
     * - `0.2.0-rc.2` removed it and provides **`configForms`** plus `settingsSchema`;
     *   `configForms.get(entryId)` returns the controller for one namespace, with the
     *   same `getSnapshot()` / `subscribe()` / `set(field, value)` face.
     *
     * Neither name may live here. {@link apply} resolves whichever one this deployment
     * has through a *non-blocking* `ctx.inject`, so an absent provider costs the
     * settings page and nothing else.
     */
    const inject = ["slots"];

    /** Nav position: general=0, models=10, plugins=15, agent-presets=20. */
    const SECTION_ORDER = 25;

    /**
     * Bind the settings page to whichever settings service this DSH generation
     * provides, without ever blocking this half's activation.
     *
     * Both candidate services are tried through `ctx.inject`, which only runs its
     * callback once the service exists and never holds the plugin pending. The two
     * names are mutually exclusive across the generations this bundle supports (0.1.x
     * ships `settingsScope`, 0.2 ships `configForms`), so the first one to arrive wins
     * and `bound` makes a second registration impossible even if a future deployment
     * shipped both.
     *
     * The page is registered on the plugin's own context rather than the provider's, so
     * it outlives a provider that appears and disappears; a controller that loses its
     * backing namespace reports `unavailable` through its own snapshot, which the page
     * already renders as an explanation instead of an empty switch.
     *
     * @param ctx - the plugin context that owns the `slots` service.
     */
    function bindSettingsPage(ctx) {
      let bound = false;
      const adopt = (scope) => {
        if (bound || scope === undefined || scope === null) return;
        bound = true;
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
              // `id` is the section key the nav and `only` filtering use; it stays the
              // settings namespace so the page and its Host half name the same thing —
              // on 0.2 that string is also the profile entry id the host projects.
              id: NAMESPACE,
              order: SECTION_ORDER,
              // The shell reads this on every render, so it stays a fresh function
              // over the current locale rather than a frozen string.
              label: () => TEXT.title,
            },
            Page,
          ),
        );
      };

      // 0.2 and later. `get(entryId)` is the per-namespace controller.
      ctx.inject(["configForms"], (formsCtx) => {
        adopt(formsCtx.configForms?.get?.(NAMESPACE));
      });
      // 0.1.x. `bind({ namespace })` is the per-namespace scope.
      ctx.inject(["settingsScope"], (scopeCtx) => {
        adopt(scopeCtx.settingsScope?.bind?.({ namespace: NAMESPACE }));
      });
    }

    function apply(ctx) {
      bindSettingsPage(ctx);
    }

    exports.apply = apply;
    exports.inject = inject;
    // Test seam: the presentation helpers and sub-components, so the markup
    // rules can be rendered and asserted without a browser. Not part of the
    // plugin contract — the runner reads only `apply` and `inject`.
    exports.__internals = { TEXT, NAMESPACE, API, SECTION_ORDER, resolveCardView, bindSettingsPage, stateText, stateColor, platformText, writeSwitch, validHostName, writeHostName, HostNameForm, readStatus, maskIdentifier, Switch, LoginForm, AuthLoginPanel, safeLoginUrl, loginError, DeviceRow, createCindySettingsPage };
    return module.exports;
  },
});
