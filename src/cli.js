#!/usr/bin/env node
import { LibrarianStore } from "./store.js";

const command = process.argv[2] || "help";
const store = new LibrarianStore();

try {
  if (command === "rebuild") {
    store.rebuildIndex();
    console.log(`Rebuilt index from ${store.eventsPath}`);
  } else if (command === "seed") {
    seed(store);
    console.log(`Seeded sample proposal and operating memory in ${store.dataDir}`);
  } else {
    console.log("Usage: node src/cli.js <rebuild|seed>");
  }
} finally {
  store.close();
}

function seed(target) {
  const existing = target.listMemories({});
  if (existing.length) return;

  target.createMemory({
    agent_id: "system",
    title: "The Librarian protects identity memory",
    body: "Identity and relationship memories should be proposed for review rather than written directly by agents.",
    category: "tools",
    visibility: "common",
    scope: "tool",
    priority: "high",
    confidence: "strong",
    tags: ["librarian", "policy"]
  });

  target.createMemory({
    agent_id: "system",
    title: "User identity context belongs in proposals first",
    body: "The user wants durable identity and relationship context preserved carefully, without agents silently rewriting it.",
    category: "identity",
    visibility: "common",
    scope: "global",
    priority: "core",
    confidence: "working",
    tags: ["identity", "protected"]
  });
}
