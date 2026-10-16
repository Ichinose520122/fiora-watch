export function createChatBridge(config, request = fetch) {
  return async (grant, data) => {
    if (!grant.chatGrant) throw Object.assign(new Error('请从 Fiora 重新进入以连接聊天'), { status: 409 });
    const response = await request(new URL('/api/watch/chat', config.issuer), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${grant.chatGrant}` },
      body: JSON.stringify(data),
    });
    if (!response.headers.get('content-type')?.includes('application/json')) throw Object.assign(new Error('请升级 Fiora 以启用影院聊天'), { status: 503 });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || '聊天暂不可用'), { status: response.status });
    return result;
  };
}
