export type Role = "admin" | "user" | "guest";

export type Permission = "read" | "write" | "delete" | "admin";

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
	admin: ["read", "write", "delete", "admin"],
	user: ["read", "write"],
	guest: ["read"],
};

export function hasPermission(role: Role, permission: Permission): boolean {
	return ROLE_PERMISSIONS[role].includes(permission);
}

export function requirePermission(role: Role, permission: Permission): void {
	if (!hasPermission(role, permission)) {
		throw new Error(`Role ${role} lacks permission ${permission}`);
	}
}
