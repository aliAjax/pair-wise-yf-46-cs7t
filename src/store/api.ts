import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type { RundownItem } from "../types";
import { loadMaster } from "./master";
import { seedItems } from "./seed";

export const rundownApi = createApi({
  reducerPath: "rundownApi",
  baseQuery: fakeBaseQuery(),
  tagTypes: ["Rundown"],
  endpoints: (builder) => ({
    getRundown: builder.query<{ items: RundownItem[]; version: number }, void>({
      queryFn: async () => {
        const master = loadMaster(seedItems);
        return { data: { items: master.items, version: master.version } };
      },
      providesTags: ["Rundown"]
    })
  })
});

export const { useGetRundownQuery } = rundownApi;
