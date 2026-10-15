import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export function signTicket(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function verifyTicket(ticket, { secret, issuer, audience }, now = Date.now()) {
  if (typeof ticket !== 'string' || ticket.length > 8192) throw new Error('无效的登录票据');
  const [body, signature, extra] = ticket.split('.');
  const actual = Buffer.from(signature || '', 'base64url');
  const expected = createHmac('sha256', secret).update(body || '').digest();
  if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('登录票据签名无效');
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  const seconds = Math.floor(now / 1000);
  if (p.v !== 1 || p.iss !== issuer || p.aud !== audience ||
      !Number.isInteger(p.iat) || !Number.isInteger(p.exp) || p.iat > seconds + 10 ||
      p.exp <= seconds || p.exp - p.iat > 60 || p.exp <= p.iat ||
      !/^[a-f0-9]{32}$/.test(p.jti) || !/^[a-f0-9]{24}$/.test(p.sub) ||
      !/^(?:[a-f0-9]{24}|[a-f0-9]{48})$/.test(p.room) ||
      typeof p.name !== 'string' || p.name.length > 100 ||
      typeof p.canControl !== 'boolean' || typeof p.admin !== 'boolean') throw new Error('登录票据已过期或参数无效，请从 Fiora 重新进入');
  return p;
}

export const randomId = () => randomBytes(24).toString('hex');
