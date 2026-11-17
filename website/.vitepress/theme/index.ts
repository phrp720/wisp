import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";

import Home from "./components/Home.vue";
import "./style.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    // The landing page's sections, used from index.md.
    app.component("Home", Home);
  },
} satisfies Theme;
