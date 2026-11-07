import type { MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { html, title } from "virtual:bot-guide";
import { PageHeader, Panel } from "../ui";

// The guide's content lives in docs/bot-guide.md; vite.config.ts renders it.
export default function Docs() {
  const navigate = useNavigate();

  // Keep the guide's internal links inside the SPA rather than reloading.
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    const href = (e.target as Element)
      .closest("a")
      ?.getAttribute("href");
    if (href?.startsWith("/")) {
      e.preventDefault();
      void navigate(href);
    }
  };

  return (
    <>
      <PageHeader title={title} />
      <Panel full className="docs">
        <div onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      </Panel>
    </>
  );
}
