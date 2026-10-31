export const USER_ROLES = ['customer', 'restaurant_owner', 'courier', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: unknown): value is UserRole{
    return USER_ROLES.includes(value as UserRole);
}

export interface AuthenticatedUser {
    id: string;
    role: UserRole;
}