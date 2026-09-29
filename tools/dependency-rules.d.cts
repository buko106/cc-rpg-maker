export const LOCATIONS: Record<string, "packages" | "apps">;
export const ADAPTERS: string[];
export const ALLOWED: Record<string, string[] | "*">;
export const NAMES: string[];
export function isAllowed(from: string, to: string): boolean;
export function allowedOf(from: string): string[];
