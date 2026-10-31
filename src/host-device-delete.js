/** Delete only a known offline peer; never refresh or replace credentials. */
export async function deleteAccountDevice({ deviceId, session, snapshot, url, fetchImpl }) {
  const fail = (statusCode, message) => ({ ok: false, statusCode, message });
  if (typeof deviceId !== 'string' || !deviceId.trim()) return fail(400, '设备 ID 无效');
  if (!session?.accessToken) return fail(401, '现有登录态不可用，请检查凭据存储');
  if (deviceId === session.deviceId || deviceId === snapshot.host?.deviceId) return fail(409, '不能删除当前主机');
  const device = snapshot.devices.find(row => row.deviceId === deviceId);
  if (!device) return fail(404, '设备不在当前列表中，请刷新');
  if (device.online !== false) return fail(409, '在线设备不能删除，请先将该设备断开');
  try {
    const response = await fetchImpl(url + '/' + encodeURIComponent(deviceId), {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + session.accessToken, accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) return fail(response.status === 401 ? 401 : 409,
      response.status === 401 ? '登录态已过期，未删除设备，也未清除凭据' : '删除失败：设备可能已上线，请刷新后重试');
    if (body?.deleted !== true || body.deviceId !== deviceId) return fail(502, '服务未确认删除，请刷新设备列表');
    return { ok: true, deviceId, deleted: true };
  } catch {
    return fail(502, '无法确认删除结果，请检查网络并刷新列表');
  }
}
