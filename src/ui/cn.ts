import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class names; a later Tailwind class wins over an earlier one. */
export const cn = (...classes: ClassValue[]) => twMerge(clsx(classes));
