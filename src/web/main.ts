import { VueQueryPlugin } from "@tanstack/vue-query";
import { createApp } from "vue";
import App from "./App.vue";
import { createQueryClient } from "./client/queries";
import { createAppI18n } from "./i18n";
import { createAppRouter } from "./router";
import "./styles/main.css";
import "vue-sonner/style.css";

createApp(App)
  .use(createAppRouter())
  .use(createAppI18n())
  .use(VueQueryPlugin, { queryClient: createQueryClient() })
  .mount("#app");
