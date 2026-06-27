# health-export-mcp — zero-dependency MCP server (stdio JSON-RPC 2.0).
# Used by directories (e.g. Glama) to build the server and run MCP introspection
# (initialize + tools/list). No real Apple Health data is required for introspection.
FROM node:20-alpine
WORKDIR /app
COPY . .
# Zero dependencies — nothing to install.
ENTRYPOINT ["node", "server.mjs"]
