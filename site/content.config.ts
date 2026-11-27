// SPDX-License-Identifier: GPL-3.0-or-later
import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { z } from 'astro/zod';

// Every page of the site is a Markdown file under site/content/docs/.
export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    // `eyebrow`: the short gold line above the home page's title.
    schema: docsSchema({ extend: z.object({ eyebrow: z.string().optional() }) }),
  }),
};
