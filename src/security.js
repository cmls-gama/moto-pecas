import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(password, hash) {
  const [salt, encoded] = hash.split(':');
  const actual = await scrypt(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(encoded, 'hex'));
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function publicUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    totalSpentCents: user.totalSpentCents,
    isVip: user.totalSpentCents >= 30000,
    remainingForVipCents: Math.max(0, 30000 - user.totalSpentCents),
  };
}
