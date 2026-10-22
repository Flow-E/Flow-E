import type { Metadata } from 'next';
import { marked } from 'marked';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { README_SECTIONS } from '@/content/readme.generated';

export const metadata: Metadata = { title: 'Docs' };

// The repository README is the single source of these docs (synced at build time). Sections
// that only make sense on GitHub are left out.
const SKIP = new Set(['licence', 'development']);

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function render(markdown: string): string {
  // Trusted content (our own README), so HTML from it is allowed; ### headings get anchors.
  const renderer = new marked.Renderer();
  renderer.heading = ({ tokens, depth }) => {
    const text = renderer.parser.parseInline(tokens);
    return `<h${depth} id="${slug(text)}">${text}</h${depth}>`;
  };
  return marked.parse(markdown, { renderer, async: false });
}

export default function DocsPage() {
  const sections = README_SECTIONS.filter((s) => !SKIP.has(s.id));
  return (
    <>
      <SiteHeader />
      <main className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[14rem_1fr]">
        <nav aria-label="Documentation" className="lg:sticky lg:top-8 lg:self-start">
          <p className="mb-2 text-sm font-semibold text-ink">On this page</p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm lg:block lg:space-y-1">
            {sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="text-ink-2 hover:text-ink">
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <article className="min-w-0">
          <h1 className="font-serif text-4xl tracking-[-0.015em] sm:text-5xl">
            Flow-E documentation
          </h1>
          <p className="mt-4 max-w-[70ch] text-lg text-ink-2">
            How to run Flow-E, connect an agent, write a mandate, and check the signed ledger. The
            package is not on npm yet: install it from a checkout of the repository, as shown below.
          </p>
          {sections.map((s) => (
            <section key={s.id} id={s.id} className="mt-14 scroll-mt-6 border-t border-rule pt-8">
              <h2 className="mb-4 font-serif text-2xl tracking-[-0.01em] text-ink sm:text-3xl">
                {s.title}
              </h2>
              <div
                className="prose-docs"
                dangerouslySetInnerHTML={{ __html: render(s.markdown) }}
              />
            </section>
          ))}
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
