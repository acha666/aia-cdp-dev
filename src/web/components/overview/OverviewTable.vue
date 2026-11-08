<script setup lang="ts">
import { useI18n } from "vue-i18n";
import QueryError from "@/components/QueryError.vue";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

defineProps<{
  list: "certificates" | "crls";
  columns: readonly { label: string; class?: string }[];
  count?: number;
  error: unknown;
}>();
defineEmits<{ retry: [] }>();

const { t } = useI18n();
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>
        <h2>{{ t(`app.sections.${list}`) }}</h2>
      </CardTitle>
      <CardDescription v-if="count !== undefined">
        {{ t("common.itemCount", { count }, count) }}
      </CardDescription>
    </CardHeader>
    <CardContent>
      <QueryError
        v-if="error && count === undefined"
        :error="error"
        :title="t(`overview.${list}Failed`)"
        @retry="$emit('retry')"
      />
      <Table v-else>
        <TableHeader>
          <TableRow>
            <TableHead v-for="column in columns" :key="column.label" :class="column.class">
              {{ t(column.label) }}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <template v-if="count === undefined">
            <TableRow v-for="index in 3" :key="index" data-testid="skeleton-row">
              <TableCell v-for="column in columns" :key="column.label" :class="column.class">
                <Skeleton class="h-4 w-20" />
              </TableCell>
            </TableRow>
          </template>
          <TableEmpty v-else-if="count === 0" :colspan="columns.length">
            {{ t(`app.empty.${list}`) }}
          </TableEmpty>
          <slot v-else />
        </TableBody>
      </Table>
    </CardContent>
  </Card>
</template>
