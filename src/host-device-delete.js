/** Delete only a known offline peer; credential renewal belongs to the Host owner. */
export async function deleteAccountDevice({ deviceId, session, snapshot, url, fetchImpl, refreshSession, getSnapshot = () => snapshot }) {
  const fail = (statusCode, message) => ({ ok: false, statusCode, message });
  const validate = () => {
    if (typeof deviceId !== 'string' || !deviceId.trim()) return fail(400, '设备 ID 无效');
    if (!session?.accessToken) return fail(401, '现有登录态不可用，请检查凭据存储');
    const current = getSnapshot();
    if (deviceId === session.deviceId || deviceId === current.host?.deviceId) return fail(409, '不能删除当前主机');
    const device = current.devices.find(row => row.deviceId === deviceId);
    if (!device) return fail(404, '设备不在当前列表中，请刷新');
    if (device.online !== false) return fail(409, '在线设备不能删除，请先将该设备断开');
    return null;
  };
  const invalid = validate();
  if (invalid) return invalid;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetchImpl(url + '/' + encodeURIComponent(deviceId), {
        method: 'DELETE', headers: { Authorization: 'Bearer ' + session.accessToken, accept: 'application/json', 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      const body = await response.json().catch(() => null);
      if (response.status === 401 && attempt === 0 && refreshSession) {
        const renewed = await refreshSession(session);
        if (renewed) {
          session = renewed;
          const invalid = validate();
          if (invalid) return invalid;
          continue;
        }
      }
      if (!response.ok) {
        const messages = {
          401: '登录态已过期，未删除设备，也未清除凭据',
          403: '服务拒绝删除：当前账号无权删除此设备',
          404: '服务未找到该设备，请刷新设备列表',
          405: '当前服务不支持设备删除接口',
          409: '服务拒绝删除：设备状态冲突，请刷新设备列表',
          429: '删除请求过于频繁，请稍后重试',
        };
        const code = response.status >= 400 && response.status <= 599 ? response.status : 502;
        return fail(code, messages[code] ?? ('设备删除服务请求失败（HTTP ' + code + '），请稍后重试'));
      }
      if (body?.deleted !== true || body.deviceId !== deviceId) return fail(502, '服务未确认删除，请刷新设备列表');
      return { ok: true, deviceId, deleted: true };
    }
  } catch {
    return fail(502, '无法确认删除结果，请检查网络并刷新列表');
  }
}
