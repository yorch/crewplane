import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const REPO = "https://github.com/yorch/crewplane";

export default defineConfig({
  site: "https://yorch.github.io",
  base: "/crewplane",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "Crewplane",
      description:
        "Local orchestration for coding agents across harnesses: tasks, isolated worktrees, review, supervision and a dashboard in one executable.",
      logo: { src: "./src/assets/mark.svg", alt: "" },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: REPO }],
      customCss: ["./src/styles/starlight.css"],
      sidebar: [
        { label: "Guide", items: ["docs/usage", "docs/dashboard"] },
        {
          label: "Reference",
          items: ["docs/architecture", "docs/contracts", "docs/decisions"],
        },
        { label: "Project", items: ["docs/status", "docs/releasing"] },
      ],
      head: [
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: "https://yorch.github.io/crewplane/og.png",
          },
        },
        {
          tag: "meta",
          attrs: { name: "twitter:card", content: "summary_large_image" },
        },
      ],
    }),
  ],
});
