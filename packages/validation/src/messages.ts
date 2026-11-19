import { z } from 'zod';

/**
 * Plain-language validation messages for customers (used by both the web app and
 * the functions' field errors). Schema-specific messages still take precedence.
 */
export function friendlyMessage(issue: z.core.$ZodRawIssue): string | undefined {
  switch (issue.code) {
    case 'too_small':
      if (issue.origin === 'string') return Number(issue.minimum) <= 1 ? 'This field is required' : `Enter at least ${issue.minimum} characters`;
      if (issue.origin === 'array') return Number(issue.minimum) <= 1 ? 'Add at least one item' : `Add at least ${issue.minimum} items`;
      return `Must be at least ${issue.minimum}`;
    case 'too_big':
      if (issue.origin === 'string') return `Use at most ${issue.maximum} characters`;
      if (issue.origin === 'array') return `No more than ${issue.maximum} items`;
      return `Must be at most ${issue.maximum}`;
    case 'invalid_type':
      if (issue.expected === 'number') return 'Enter a number';
      if (issue.input === undefined) return 'This field is required';
      return 'Invalid value';
    case 'invalid_value':
      return 'Please choose an option';
    case 'invalid_format':
      return issue.format === 'email' ? 'Enter a valid email address' : 'Invalid format';
    case 'not_multiple_of':
      return 'Enter a whole number';
    default:
      return undefined;
  }
}

z.config({ customError: friendlyMessage });
