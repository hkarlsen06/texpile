// the name in a chip that is one bare call (\bert, \ie{}), which the paper may define itself
const CALL = /^\s*\\([a-zA-Z@]+)(?:\{\})?\s*$/;

export function macroCall(source: string): string | null {
	return CALL.exec(source)?.[1] ?? null;
}
