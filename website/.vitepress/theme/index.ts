import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import { h } from "vue";

import Footer from "./components/Footer.vue";
import Home from "./components/Home.vue";
import Orb from "./components/Orb.vue";
import Pipeline from "./components/Pipeline.vue";
import Recording from "./components/Recording.vue";
import UseCases from "./components/UseCases.vue";
import "./style.css";

export default {
  extends: DefaultTheme,
  // Where the name comes from, under the hero's words, as the README has it under its title.
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "home-hero-info-after": () => h("p", { class: "wisp-name" }, "Wisp, as in will-o'-the-wisp: the little light that leads the way."),
      // Wisp's own orb, drawn for the website; the 🔮 emoji is the terminal's.
      "home-hero-image": () => h(Orb),
      // A footer on every page, docs included, which VitePress's own leaves out.
      "layout-bottom": () => h(Footer),
    }),
  enhanceApp({ app }) {
    // The landing page's sections, used from index.md.
    app.component("Home", Home);
    app.component("Recording", Recording);
    app.component("Pipeline", Pipeline);
    app.component("UseCases", UseCases);
  },
} satisfies Theme;
