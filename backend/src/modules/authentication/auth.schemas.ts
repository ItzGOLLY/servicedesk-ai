import { z } from 'zod';

/**
 * Password policy is enforced here rather than in the database so the user gets
 * a specific, actionable message instead of a constraint violation.
 */
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password must be at most 128 characters.')
  .regex(/[A-Za-z]/, 'Password must contain at least one letter.')
  .regex(/[0-9]/, 'Password must contain at least one number.');

export const registerSchema = z.object({
  fullName: z.string().trim().min(2, 'Please enter your full name.').max(120),
  email: z.string().trim().toLowerCase().email('Please enter a valid email address.'),
  password,
  phone: z.string().trim().max(20).optional().or(z.literal('')),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Please enter a valid email address.'),
  password: z.string().min(1, 'Please enter your password.'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Please enter your current password.'),
  newPassword: password,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
