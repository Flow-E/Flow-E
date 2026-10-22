/** A form field as text. Files (or a missing field) become the fallback, never "[object File]". */
export function text(form: FormData, name: string, fallback = ''): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : fallback;
}

/** Every value of a repeated field, as text. */
export function texts(form: FormData, name: string): string[] {
  return form.getAll(name).filter((v): v is string => typeof v === 'string');
}
