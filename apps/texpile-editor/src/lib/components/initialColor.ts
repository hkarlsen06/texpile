/**
 * A stable color for a name.
 *
 * A live session could hand out colors, but a comment log cannot: it is read on another machine,
 * months later, by someone who was never in a session. Deriving the hue from the name means the
 * same person is the same color everywhere, for everyone, with nothing stored.
 *
 * Saturation and lightness are fixed, not hashed: they are what keeps white text legible on top,
 * and a hashed lightness would eventually pick a color that makes the initial disappear.
 */
export function colorFor(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
	return `hsl(${Math.abs(hash) % 360}deg 55% 42%)`;
}
