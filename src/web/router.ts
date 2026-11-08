import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw, RouterHistory, RouterScrollBehavior } from "vue-router";
import NotFoundPage from "@/pages/NotFoundPage.vue";
import OverviewPage from "@/pages/OverviewPage.vue";

const CERTIFICATE_ID = "[0-9a-f]{64}";
const TARGET_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const routes: RouteRecordRaw[] = [
  { path: "/", name: "overview", component: OverviewPage },
  {
    path: `/certificates/:id(${CERTIFICATE_ID})`,
    name: "certificate",
    component: () => import("@/pages/CertificatePage.vue"),
    props: true,
    sensitive: true,
  },
  {
    path: `/crls/:targetId(${TARGET_ID})`,
    name: "crl",
    component: () => import("@/pages/CrlTargetPage.vue"),
    props: true,
    sensitive: true,
  },
  { path: "/:pathMatch(.*)*", name: "not-found", component: NotFoundPage },
];

const scrollBehavior: RouterScrollBehavior = (to, from, saved) => {
  if (saved) {
    return saved;
  }
  if (to.hash) {
    return { el: to.hash };
  }
  return to.path === from.path ? false : { top: 0 };
};

export function createAppRouter(history: RouterHistory = createWebHistory()) {
  return createRouter({ history, routes, scrollBehavior });
}
