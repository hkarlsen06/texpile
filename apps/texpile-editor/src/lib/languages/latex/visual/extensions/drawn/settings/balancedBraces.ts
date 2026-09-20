/** every brace closed in order, escaped ones aside, so an argument's text cannot close its command early or leave it open */
export function balancedBraces(text: string): boolean {
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\\') i++;
		else if (text[i] === '{') depth++;
		else if (text[i] === '}' && --depth < 0) return false;
	}
	return depth === 0;
}
