// benchmarks/fixtures/synthetic/generate.ts
//
// Generates a 50-file synthetic TypeScript repo with known call chains.
// Run once: `npx tsx benchmarks/fixtures/synthetic/generate.ts`
// Output: benchmarks/fixtures/synthetic/repo/
//
// Structure:
//   auth/   — 13 files: crypto, tokens, login, register, middleware, etc.
//   api/    — 13 files: routes, handlers, middleware, validators, etc.
//   db/     — 12 files: connection, models, queries, migrations, etc.
//   utils/  — 12 files: logger, config, errors, validation, etc.
//
// Known call chains for blast radius testing:
//   hashPassword (auth/crypto.ts)
//     <- register (auth/register.ts)          hop 1
//     <- resetPassword (auth/reset-password.ts) hop 1
//     <- handleUserCreate (api/user-routes.ts)  hop 2 (via register)
//     <- handlePasswordReset (api/user-routes.ts) hop 2 (via resetPassword)
//
//   getConnection (db/connection.ts)
//     <- findUserByEmail (db/user-queries.ts)  hop 1
//     <- findUserById (db/user-queries.ts)     hop 1
//     <- login (auth/login.ts)                 hop 2 (via findUserByEmail)
//     <- getUserProfile (api/profile-routes.ts) hop 2 (via findUserById)

import fs from "node:fs";
import path from "node:path";

const OUT = path.join(
	path.dirname(new URL(import.meta.url).pathname),
	"repo",
);

type FileSpec = { path: string; content: string };

function emit(files: FileSpec[]): void {
	if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true });
	fs.mkdirSync(OUT, { recursive: true });

	for (const file of files) {
		const full = path.join(OUT, file.path);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, file.content);
	}

	// Note: git init is NOT done here. The source files are committed to the
	// parent repo as a deterministic fixture. The quality suite initializes
	// the nested .git at runtime via initSyntheticGit().
}

// ── utils/ (12 files) ──────────────────────────────────────
const utilsFiles: FileSpec[] = [
	{
		path: "utils/index.ts",
		content: `export { createLogger } from "./logger.js";\nexport { loadConfig } from "./config.js";\nexport { AppError, ValidationError } from "./errors.js";\nexport { validate } from "./validation.js";\n`,
	},
	{
		path: "utils/logger.ts",
		content: `export function createLogger(name: string) {\n\treturn {\n\t\tinfo: (msg: string) => console.log(\`[\${name}] \${msg}\`),\n\t\terror: (msg: string) => console.error(\`[\${name}] \${msg}\`),\n\t\twarn: (msg: string) => console.warn(\`[\${name}] \${msg}\`),\n\t};\n}\n\nexport type Logger = ReturnType<typeof createLogger>;\n`,
	},
	{
		path: "utils/config.ts",
		content: `export type AppConfig = {\n\tport: number;\n\tdbUrl: string;\n\tjwtSecret: string;\n\tlogLevel: string;\n};\n\nexport function loadConfig(): AppConfig {\n\treturn {\n\t\tport: Number(process.env.PORT) || 3000,\n\t\tdbUrl: process.env.DATABASE_URL || "postgres://localhost/app",\n\t\tjwtSecret: process.env.JWT_SECRET || "dev-secret",\n\t\tlogLevel: process.env.LOG_LEVEL || "info",\n\t};\n}\n`,
	},
	{
		path: "utils/errors.ts",
		content: `export class AppError extends Error {\n\tconstructor(public statusCode: number, message: string) {\n\t\tsuper(message);\n\t\tthis.name = "AppError";\n\t}\n}\n\nexport class ValidationError extends AppError {\n\tconstructor(message: string) {\n\t\tsuper(400, message);\n\t\tthis.name = "ValidationError";\n\t}\n}\n\nexport class NotFoundError extends AppError {\n\tconstructor(resource: string) {\n\t\tsuper(404, \`\${resource} not found\`);\n\t\tthis.name = "NotFoundError";\n\t}\n}\n\nexport class AuthError extends AppError {\n\tconstructor(message: string) {\n\t\tsuper(401, message);\n\t\tthis.name = "AuthError";\n\t}\n}\n`,
	},
	{
		path: "utils/validation.ts",
		content: `import { ValidationError } from "./errors.js";\n\nexport function validate(condition: boolean, message: string): void {\n\tif (!condition) throw new ValidationError(message);\n}\n\nexport function validateEmail(email: string): void {\n\tvalidate(email.includes("@"), "Invalid email address");\n}\n\nexport function validatePassword(password: string): void {\n\tvalidate(password.length >= 8, "Password must be at least 8 characters");\n}\n`,
	},
	{
		path: "utils/hash.ts",
		content: `import { createHash } from "node:crypto";\n\nexport function sha256(input: string): string {\n\treturn createHash("sha256").update(input).digest("hex");\n}\n\nexport function md5(input: string): string {\n\treturn createHash("md5").update(input).digest("hex");\n}\n`,
	},
	{
		path: "utils/date.ts",
		content: `export function now(): Date {\n\treturn new Date();\n}\n\nexport function formatDate(date: Date): string {\n\treturn date.toISOString().slice(0, 10);\n}\n\nexport function daysAgo(n: number): Date {\n\tconst d = now();\n\td.setDate(d.getDate() - n);\n\treturn d;\n}\n`,
	},
	{
		path: "utils/string.ts",
		content: `export function slugify(input: string): string {\n\treturn input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n}\n\nexport function truncate(input: string, maxLen: number): string {\n\tif (input.length <= maxLen) return input;\n\treturn input.slice(0, maxLen - 3) + "...";\n}\n`,
	},
	{
		path: "utils/env.ts",
		content: `export function requireEnv(key: string): string {\n\tconst value = process.env[key];\n\tif (!value) throw new Error(\`Missing env var: \${key}\`);\n\treturn value;\n}\n\nexport function optionalEnv(key: string, fallback: string): string {\n\treturn process.env[key] || fallback;\n}\n`,
	},
	{
		path: "utils/retry.ts",
		content: `export async function retry<T>(\n\tfn: () => Promise<T>,\n\tmaxAttempts: number = 3,\n\tdelayMs: number = 100,\n): Promise<T> {\n\tlet lastError: Error | undefined;\n\tfor (let i = 0; i < maxAttempts; i++) {\n\t\ttry {\n\t\t\treturn await fn();\n\t\t} catch (err) {\n\t\t\tlastError = err instanceof Error ? err : new Error(String(err));\n\t\t\tif (i < maxAttempts - 1) {\n\t\t\t\tawait new Promise((r) => setTimeout(r, delayMs * (i + 1)));\n\t\t\t}\n\t\t}\n\t}\n\tthrow lastError;\n}\n`,
	},
	{
		path: "utils/id.ts",
		content: `import { randomUUID } from "node:crypto";\n\nexport function generateId(): string {\n\treturn randomUUID();\n}\n\nexport function shortId(): string {\n\treturn randomUUID().slice(0, 8);\n}\n`,
	},
	{
		path: "utils/types.ts",
		content: `export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };\n\nexport function ok<T>(value: T): Result<T, never> {\n\treturn { ok: true, value };\n}\n\nexport function err<E>(error: E): Result<never, E> {\n\treturn { ok: false, error };\n}\n`,
	},
];

// ── db/ (12 files) ─────────────────────────────────────────
const dbFiles: FileSpec[] = [
	{
		path: "db/index.ts",
		content: `export { getConnection, closeConnection } from "./connection.js";\nexport { findUserByEmail, findUserById, createUser } from "./user-queries.js";\nexport { findPostsByUser, createPost } from "./post-queries.js";\n`,
	},
	{
		path: "db/connection.ts",
		content: `import { createLogger } from "../utils/logger.js";\nimport { loadConfig } from "../utils/config.js";\n\nconst log = createLogger("db");\n\nlet pool: unknown = null;\n\nexport function getConnection(): unknown {\n\tif (!pool) {\n\t\tconst config = loadConfig();\n\t\tlog.info(\`Connecting to \${config.dbUrl}\`);\n\t\tpool = { connected: true, url: config.dbUrl };\n\t}\n\treturn pool;\n}\n\nexport function closeConnection(): void {\n\tpool = null;\n\tlog.info("Connection closed");\n}\n`,
	},
	{
		path: "db/user-queries.ts",
		content: `import { getConnection } from "./connection.js";\nimport { NotFoundError } from "../utils/errors.js";\n\nexport type User = { id: string; email: string; passwordHash: string; name: string };\n\nexport function findUserByEmail(email: string): User | null {\n\tconst _conn = getConnection();\n\treturn null; // stub\n}\n\nexport function findUserById(id: string): User {\n\tconst _conn = getConnection();\n\tthrow new NotFoundError("User");\n}\n\nexport function createUser(data: Omit<User, "id">): User {\n\tconst _conn = getConnection();\n\treturn { id: "generated", ...data };\n}\n`,
	},
	{
		path: "db/post-queries.ts",
		content: `import { getConnection } from "./connection.js";\n\nexport type Post = { id: string; userId: string; title: string; body: string; createdAt: Date };\n\nexport function findPostsByUser(userId: string): Post[] {\n\tconst _conn = getConnection();\n\treturn [];\n}\n\nexport function createPost(userId: string, title: string, body: string): Post {\n\tconst _conn = getConnection();\n\treturn { id: "generated", userId, title, body, createdAt: new Date() };\n}\n`,
	},
	{
		path: "db/session-queries.ts",
		content: `import { getConnection } from "./connection.js";\n\nexport type Session = { id: string; userId: string; token: string; expiresAt: Date };\n\nexport function createSession(userId: string, token: string): Session {\n\tconst _conn = getConnection();\n\treturn { id: "generated", userId, token, expiresAt: new Date(Date.now() + 86400000) };\n}\n\nexport function findSession(token: string): Session | null {\n\tconst _conn = getConnection();\n\treturn null;\n}\n\nexport function deleteSession(token: string): void {\n\tconst _conn = getConnection();\n}\n`,
	},
	{
		path: "db/migration-runner.ts",
		content: `import { getConnection } from "./connection.js";\nimport { createLogger } from "../utils/logger.js";\n\nconst log = createLogger("migrations");\n\nexport type Migration = { name: string; up: () => void; down: () => void };\n\nexport function runMigrations(migrations: Migration[]): void {\n\tconst _conn = getConnection();\n\tfor (const m of migrations) {\n\t\tlog.info(\`Running migration: \${m.name}\`);\n\t\tm.up();\n\t}\n}\n`,
	},
	{
		path: "db/seed.ts",
		content: `import { createUser } from "./user-queries.js";\nimport { createPost } from "./post-queries.js";\nimport { createLogger } from "../utils/logger.js";\n\nconst log = createLogger("seed");\n\nexport function seedDatabase(): void {\n\tlog.info("Seeding database");\n\tconst user = createUser({ email: "test@test.com", passwordHash: "hash", name: "Test" });\n\tcreatePost(user.id, "Hello World", "First post");\n}\n`,
	},
	{
		path: "db/comment-queries.ts",
		content: `import { getConnection } from "./connection.js";\n\nexport type Comment = { id: string; postId: string; userId: string; body: string };\n\nexport function findCommentsByPost(postId: string): Comment[] {\n\tconst _conn = getConnection();\n\treturn [];\n}\n\nexport function createComment(postId: string, userId: string, body: string): Comment {\n\tconst _conn = getConnection();\n\treturn { id: "generated", postId, userId, body };\n}\n`,
	},
	{
		path: "db/tag-queries.ts",
		content: `import { getConnection } from "./connection.js";\n\nexport type Tag = { id: string; name: string };\n\nexport function findTagByName(name: string): Tag | null {\n\tconst _conn = getConnection();\n\treturn null;\n}\n\nexport function createTag(name: string): Tag {\n\tconst _conn = getConnection();\n\treturn { id: "generated", name };\n}\n\nexport function tagPost(postId: string, tagId: string): void {\n\tconst _conn = getConnection();\n}\n`,
	},
	{
		path: "db/health.ts",
		content: `import { getConnection } from "./connection.js";\n\nexport function checkDbHealth(): boolean {\n\ttry {\n\t\tgetConnection();\n\t\treturn true;\n\t} catch {\n\t\treturn false;\n\t}\n}\n`,
	},
	{
		path: "db/types.ts",
		content: `export type QueryResult<T> = { rows: T[]; rowCount: number };\n\nexport type Paginated<T> = { items: T[]; total: number; page: number; pageSize: number };\n\nexport function paginate<T>(items: T[], page: number, pageSize: number): Paginated<T> {\n\tconst start = (page - 1) * pageSize;\n\treturn {\n\t\titems: items.slice(start, start + pageSize),\n\t\ttotal: items.length,\n\t\tpage,\n\t\tpageSize,\n\t};\n}\n`,
	},
	{
		path: "db/transaction.ts",
		content: `import { getConnection } from "./connection.js";\nimport { createLogger } from "../utils/logger.js";\n\nconst log = createLogger("tx");\n\nexport async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {\n\tconst _conn = getConnection();\n\tlog.info("BEGIN");\n\ttry {\n\t\tconst result = await fn();\n\t\tlog.info("COMMIT");\n\t\treturn result;\n\t} catch (err) {\n\t\tlog.info("ROLLBACK");\n\t\tthrow err;\n\t}\n}\n`,
	},
];

// ── auth/ (13 files) ───────────────────────────────────────
const authFiles: FileSpec[] = [
	{
		path: "auth/index.ts",
		content: `export { hashPassword, verifyPassword } from "./crypto.js";\nexport { generateToken, verifyToken } from "./tokens.js";\nexport { login } from "./login.js";\nexport { register } from "./register.js";\nexport { resetPassword } from "./reset-password.js";\n`,
	},
	{
		path: "auth/crypto.ts",
		content: `import { sha256 } from "../utils/hash.js";\n\nexport function hashPassword(password: string): string {\n\treturn sha256(password + ":salt");\n}\n\nexport function verifyPassword(password: string, hash: string): boolean {\n\treturn hashPassword(password) === hash;\n}\n`,
	},
	{
		path: "auth/tokens.ts",
		content: `import { loadConfig } from "../utils/config.js";\nimport { sha256 } from "../utils/hash.js";\n\nexport function generateToken(userId: string): string {\n\tconst config = loadConfig();\n\treturn sha256(\`\${userId}:\${config.jwtSecret}:\${Date.now()}\`);\n}\n\nexport function verifyToken(token: string): { userId: string } | null {\n\treturn token.length === 64 ? { userId: "extracted" } : null;\n}\n`,
	},
	{
		path: "auth/login.ts",
		content: `import { findUserByEmail } from "../db/user-queries.js";\nimport { verifyPassword } from "./crypto.js";\nimport { generateToken } from "./tokens.js";\nimport { createSession } from "../db/session-queries.js";\nimport { AuthError } from "../utils/errors.js";\n\nexport function login(email: string, password: string): { token: string } {\n\tconst user = findUserByEmail(email);\n\tif (!user) throw new AuthError("Invalid credentials");\n\tif (!verifyPassword(password, user.passwordHash)) throw new AuthError("Invalid credentials");\n\tconst token = generateToken(user.id);\n\tcreateSession(user.id, token);\n\treturn { token };\n}\n`,
	},
	{
		path: "auth/register.ts",
		content: `import { hashPassword } from "./crypto.js";\nimport { generateToken } from "./tokens.js";\nimport { createUser } from "../db/user-queries.js";\nimport { validateEmail, validatePassword } from "../utils/validation.js";\n\nexport function register(email: string, password: string, name: string): { token: string } {\n\tvalidateEmail(email);\n\tvalidatePassword(password);\n\tconst passwordHash = hashPassword(password);\n\tconst user = createUser({ email, passwordHash, name });\n\treturn { token: generateToken(user.id) };\n}\n`,
	},
	{
		path: "auth/reset-password.ts",
		content: `import { hashPassword } from "./crypto.js";\nimport { findUserByEmail } from "../db/user-queries.js";\nimport { validatePassword } from "../utils/validation.js";\nimport { NotFoundError } from "../utils/errors.js";\n\nexport function resetPassword(email: string, newPassword: string): void {\n\tvalidatePassword(newPassword);\n\tconst user = findUserByEmail(email);\n\tif (!user) throw new NotFoundError("User");\n\tconst _newHash = hashPassword(newPassword);\n\t// update in db...\n}\n`,
	},
	{
		path: "auth/middleware.ts",
		content: `import { verifyToken } from "./tokens.js";\nimport { AuthError } from "../utils/errors.js";\n\nexport type AuthContext = { userId: string };\n\nexport function requireAuth(token: string | undefined): AuthContext {\n\tif (!token) throw new AuthError("No token provided");\n\tconst payload = verifyToken(token);\n\tif (!payload) throw new AuthError("Invalid token");\n\treturn { userId: payload.userId };\n}\n`,
	},
	{
		path: "auth/session.ts",
		content: `import { findSession, deleteSession } from "../db/session-queries.js";\nimport { AuthError } from "../utils/errors.js";\n\nexport function validateSession(token: string): { userId: string } {\n\tconst session = findSession(token);\n\tif (!session) throw new AuthError("Session expired");\n\tif (session.expiresAt < new Date()) {\n\t\tdeleteSession(token);\n\t\tthrow new AuthError("Session expired");\n\t}\n\treturn { userId: session.userId };\n}\n\nexport function logout(token: string): void {\n\tdeleteSession(token);\n}\n`,
	},
	{
		path: "auth/password-policy.ts",
		content: `export type PasswordStrength = "weak" | "fair" | "strong";\n\nexport function checkPasswordStrength(password: string): PasswordStrength {\n\tif (password.length < 8) return "weak";\n\tconst hasUpper = /[A-Z]/.test(password);\n\tconst hasDigit = /\\d/.test(password);\n\tconst hasSpecial = /[!@#$%^&*]/.test(password);\n\tconst score = [hasUpper, hasDigit, hasSpecial].filter(Boolean).length;\n\treturn score >= 2 ? "strong" : "fair";\n}\n`,
	},
	{
		path: "auth/rate-limiter.ts",
		content: `const attempts = new Map<string, { count: number; lastAttempt: number }>();\n\nexport function checkRateLimit(key: string, maxAttempts: number = 5, windowMs: number = 60000): boolean {\n\tconst entry = attempts.get(key);\n\tconst now = Date.now();\n\tif (!entry || now - entry.lastAttempt > windowMs) {\n\t\tattempts.set(key, { count: 1, lastAttempt: now });\n\t\treturn true;\n\t}\n\tentry.count++;\n\tentry.lastAttempt = now;\n\treturn entry.count <= maxAttempts;\n}\n\nexport function resetRateLimit(key: string): void {\n\tattempts.delete(key);\n}\n`,
	},
	{
		path: "auth/two-factor.ts",
		content: `import { sha256 } from "../utils/hash.js";\n\nexport function generateOtp(secret: string): string {\n\tconst time = Math.floor(Date.now() / 30000);\n\treturn sha256(\`\${secret}:\${time}\`).slice(0, 6);\n}\n\nexport function verifyOtp(secret: string, otp: string): boolean {\n\treturn generateOtp(secret) === otp;\n}\n`,
	},
	{
		path: "auth/oauth.ts",
		content: `import { createLogger } from "../utils/logger.js";\nimport { createUser } from "../db/user-queries.js";\nimport { generateToken } from "./tokens.js";\nimport { hashPassword } from "./crypto.js";\n\nconst log = createLogger("oauth");\n\nexport function handleOAuthCallback(provider: string, profile: { email: string; name: string }): { token: string } {\n\tlog.info(\`OAuth callback from \${provider}\`);\n\tconst passwordHash = hashPassword(profile.email + ":oauth");\n\tconst user = createUser({ email: profile.email, passwordHash, name: profile.name });\n\treturn { token: generateToken(user.id) };\n}\n`,
	},
	{
		path: "auth/permissions.ts",
		content: `export type Role = "admin" | "user" | "guest";\n\nexport type Permission = "read" | "write" | "delete" | "admin";\n\nconst ROLE_PERMISSIONS: Record<Role, Permission[]> = {\n\tadmin: ["read", "write", "delete", "admin"],\n\tuser: ["read", "write"],\n\tguest: ["read"],\n};\n\nexport function hasPermission(role: Role, permission: Permission): boolean {\n\treturn ROLE_PERMISSIONS[role].includes(permission);\n}\n\nexport function requirePermission(role: Role, permission: Permission): void {\n\tif (!hasPermission(role, permission)) {\n\t\tthrow new Error(\`Role \${role} lacks permission \${permission}\`);\n\t}\n}\n`,
	},
];

// ── api/ (13 files) ────────────────────────────────────────
const apiFiles: FileSpec[] = [
	{
		path: "api/index.ts",
		content: `export { handleUserCreate, handlePasswordReset } from "./user-routes.js";\nexport { getUserProfile } from "./profile-routes.js";\nexport { handleCreatePost, handleGetPosts } from "./post-routes.js";\n`,
	},
	{
		path: "api/user-routes.ts",
		content: `import { register } from "../auth/register.js";\nimport { resetPassword } from "../auth/reset-password.js";\nimport { createLogger } from "../utils/logger.js";\n\nconst log = createLogger("api:users");\n\nexport function handleUserCreate(body: { email: string; password: string; name: string }): { token: string } {\n\tlog.info(\`Creating user: \${body.email}\`);\n\treturn register(body.email, body.password, body.name);\n}\n\nexport function handlePasswordReset(body: { email: string; newPassword: string }): void {\n\tlog.info(\`Password reset: \${body.email}\`);\n\tresetPassword(body.email, body.newPassword);\n}\n`,
	},
	{
		path: "api/profile-routes.ts",
		content: `import { findUserById } from "../db/user-queries.js";\nimport { requireAuth } from "../auth/middleware.js";\nimport { createLogger } from "../utils/logger.js";\n\nconst log = createLogger("api:profile");\n\nexport function getUserProfile(token: string): { id: string; email: string; name: string } {\n\tconst auth = requireAuth(token);\n\tlog.info(\`Getting profile for \${auth.userId}\`);\n\tconst user = findUserById(auth.userId);\n\treturn { id: user.id, email: user.email, name: user.name };\n}\n`,
	},
	{
		path: "api/post-routes.ts",
		content: `import { findPostsByUser, createPost } from "../db/post-queries.js";\nimport { requireAuth } from "../auth/middleware.js";\nimport { validate } from "../utils/validation.js";\nimport { createLogger } from "../utils/logger.js";\n\nconst log = createLogger("api:posts");\n\nexport function handleGetPosts(token: string): unknown[] {\n\tconst auth = requireAuth(token);\n\treturn findPostsByUser(auth.userId);\n}\n\nexport function handleCreatePost(token: string, title: string, body: string): unknown {\n\tconst auth = requireAuth(token);\n\tvalidate(title.length > 0, "Title required");\n\tlog.info(\`Creating post by \${auth.userId}\`);\n\treturn createPost(auth.userId, title, body);\n}\n`,
	},
	{
		path: "api/comment-routes.ts",
		content: `import { findCommentsByPost, createComment } from "../db/comment-queries.js";\nimport { requireAuth } from "../auth/middleware.js";\nimport { validate } from "../utils/validation.js";\n\nexport function handleGetComments(postId: string): unknown[] {\n\treturn findCommentsByPost(postId);\n}\n\nexport function handleCreateComment(token: string, postId: string, body: string): unknown {\n\tconst auth = requireAuth(token);\n\tvalidate(body.length > 0, "Comment body required");\n\treturn createComment(postId, auth.userId, body);\n}\n`,
	},
	{
		path: "api/tag-routes.ts",
		content: `import { findTagByName, createTag, tagPost } from "../db/tag-queries.js";\nimport { requireAuth } from "../auth/middleware.js";\nimport { slugify } from "../utils/string.js";\n\nexport function handleTagPost(token: string, postId: string, tagName: string): void {\n\trequireAuth(token);\n\tconst slug = slugify(tagName);\n\tlet tag = findTagByName(slug);\n\tif (!tag) tag = createTag(slug);\n\ttagPost(postId, tag.id);\n}\n`,
	},
	{
		path: "api/health-routes.ts",
		content: `import { checkDbHealth } from "../db/health.js";\n\nexport function handleHealthCheck(): { status: string; db: boolean } {\n\treturn { status: "ok", db: checkDbHealth() };\n}\n`,
	},
	{
		path: "api/error-handler.ts",
		content: `import { AppError } from "../utils/errors.js";\nimport { createLogger } from "../utils/logger.js";\n\nconst log = createLogger("api:error");\n\nexport function handleError(err: unknown): { statusCode: number; message: string } {\n\tif (err instanceof AppError) {\n\t\treturn { statusCode: err.statusCode, message: err.message };\n\t}\n\tlog.error(String(err));\n\treturn { statusCode: 500, message: "Internal server error" };\n}\n`,
	},
	{
		path: "api/request-logger.ts",
		content: `import { createLogger } from "../utils/logger.js";\n\nconst log = createLogger("api:request");\n\nexport function logRequest(method: string, path: string, durationMs: number): void {\n\tlog.info(\`\${method} \${path} \${durationMs}ms\`);\n}\n`,
	},
	{
		path: "api/cors.ts",
		content: `export type CorsConfig = {\n\torigins: string[];\n\tmethods: string[];\n\tallowHeaders: string[];\n};\n\nexport function defaultCorsConfig(): CorsConfig {\n\treturn {\n\t\torigins: ["*"],\n\t\tmethods: ["GET", "POST", "PUT", "DELETE"],\n\t\tallowHeaders: ["Content-Type", "Authorization"],\n\t};\n}\n\nexport function isOriginAllowed(origin: string, config: CorsConfig): boolean {\n\treturn config.origins.includes("*") || config.origins.includes(origin);\n}\n`,
	},
	{
		path: "api/rate-limit-middleware.ts",
		content: `import { checkRateLimit } from "../auth/rate-limiter.js";\nimport { AppError } from "../utils/errors.js";\n\nexport function rateLimitMiddleware(ip: string): void {\n\tif (!checkRateLimit(ip, 100, 60000)) {\n\t\tthrow new AppError(429, "Too many requests");\n\t}\n}\n`,
	},
	{
		path: "api/validators.ts",
		content: `import { validate } from "../utils/validation.js";\n\nexport function validateCreateUser(body: unknown): { email: string; password: string; name: string } {\n\tconst b = body as Record<string, unknown>;\n\tvalidate(typeof b.email === "string", "email required");\n\tvalidate(typeof b.password === "string", "password required");\n\tvalidate(typeof b.name === "string", "name required");\n\treturn b as { email: string; password: string; name: string };\n}\n\nexport function validateCreatePost(body: unknown): { title: string; body: string } {\n\tconst b = body as Record<string, unknown>;\n\tvalidate(typeof b.title === "string", "title required");\n\tvalidate(typeof b.body === "string", "body required");\n\treturn b as { title: string; body: string };\n}\n`,
	},
	{
		path: "api/response.ts",
		content: `export type ApiResponse<T> = {\n\tsuccess: boolean;\n\tdata?: T;\n\terror?: string;\n};\n\nexport function success<T>(data: T): ApiResponse<T> {\n\treturn { success: true, data };\n}\n\nexport function failure(message: string): ApiResponse<never> {\n\treturn { success: false, error: message };\n}\n`,
	},
];

const allFiles = [...utilsFiles, ...dbFiles, ...authFiles, ...apiFiles];

// Add package.json and tsconfig for realism
allFiles.push({
	path: "package.json",
	content: JSON.stringify(
		{ name: "synthetic-bench-repo", version: "1.0.0", type: "module" },
		null,
		"\t",
	) + "\n",
});

allFiles.push({
	path: "tsconfig.json",
	content: JSON.stringify(
		{
			compilerOptions: {
				target: "ES2022",
				module: "nodenext",
				moduleResolution: "nodenext",
				strict: true,
				outDir: "dist",
			},
			include: ["**/*.ts"],
		},
		null,
		"\t",
	) + "\n",
});

allFiles.push({
	path: "README.md",
	content: `# Synthetic Bench Repo\n\nGenerated fixture for ai-cortex benchmarks.\nDo not edit manually — regenerate via \`npx tsx benchmarks/fixtures/synthetic/generate.ts\`.\n`,
});

console.log(`Generating ${allFiles.length} files to ${OUT}`);
emit(allFiles);
console.log("Done.");
