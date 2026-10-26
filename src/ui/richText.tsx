import type { RichText as RichTextContent } from '@/i18n';

export function RichText({ content }: { content: RichTextContent }) {
	const ListTag = content.ordered ? 'ol' : 'ul';
	return (
		<>
			{content.paragraphs.map((paragraph) => (
				<p key={paragraph}>{paragraph}</p>
			))}
			{content.items && (
				<ListTag
					className={content.ordered ? 'list-decimal ps-5' : 'list-disc ps-5'}
				>
					{content.items.map((item) => (
						<li key={item}>{item}</li>
					))}
				</ListTag>
			)}
		</>
	);
}
