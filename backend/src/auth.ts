import type { NextFunction, Request, Response } from 'express'
import { jwtVerify, SignJWT } from 'jose'
import { requirePool } from './database.js'

const COOKIE = 'incident_command_session'

function cookieSecurity() {
  const production = process.env.NODE_ENV === 'production'
  return { sameSite: production ? 'none' as const : 'lax' as const, secure: production }
}

export interface SessionUser {
  userId: string
  organizationId: string
  email: string
  name: string
  organizationName: string
  role: 'owner' | 'admin' | 'responder' | 'viewer'
}

declare global {
  namespace Express {
    interface Request { user?: SessionUser }
  }
}

function secret() {
  const value = process.env.SESSION_SECRET
  if (!value || value.length < 32) {
    const error = new Error('SESSION_SECRET is not configured') as Error & { status?: number; setup?: string }
    error.status = 503
    error.setup = 'Set SESSION_SECRET to a random value of at least 32 characters in backend/.env.'
    throw error
  }
  return new TextEncoder().encode(value)
}

export async function createSessionToken(userId: string, organizationId: string) {
  return new SignJWT({ organizationId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret())
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    ...cookieSecurity(),
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  })
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE, { path: '/', ...cookieSecurity() })
}

export async function resolveSession(req: Request): Promise<SessionUser | null> {
  const token = req.cookies?.[COOKIE]
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secret())
    if (!payload.sub || typeof payload.organizationId !== 'string') return null
    const db = requirePool()
    const result = await db.query<SessionUser>(`
      SELECT u.id AS "userId", u.email, u.name, o.id AS "organizationId", o.name AS "organizationName", m.role
      FROM users u
      JOIN memberships m ON m.user_id = u.id
      JOIN organizations o ON o.id = m.organization_id
      WHERE u.id = $1 AND o.id = $2
    `, [payload.sub, payload.organizationId])
    return result.rows[0] || null
  } catch {
    return null
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await resolveSession(req)
    if (!user) return res.status(401).json({ error: 'Authentication required' })
    req.user = user
    next()
  } catch (error) {
    next(error)
  }
}
