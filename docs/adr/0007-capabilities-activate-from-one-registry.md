# Capabilities activate from one registry

Every Hanoon-managed skill, tool, model, native adapter, connector, and recipe activates from one versioned capability registry. Registered Hanoon tools, bundled skills, and native adapters must match declared descriptors exactly; controller mutations are granted through expiring capability bundles rather than one permanent all-tools profile, and discovery of external capabilities remains non-authorizing. This adds a bounded continuation when a new bundle is needed, but makes the active authority surface explicit and fail-closed.
