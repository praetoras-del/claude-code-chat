import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

const server = new McpServer({
  name: "Claude Code Permissions MCP Server",
  version: "0.0.1",
});

// Get permissions directory from environment
const PERMISSIONS_PATH = process.env.CLAUDE_PERMISSIONS_PATH;
if (!PERMISSIONS_PATH) {
  console.error("CLAUDE_PERMISSIONS_PATH environment variable not set");
  process.exit(1);
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

async function requestPermission(tool_name: string, input: any): Promise<{approved: boolean, reason?: string}> {
  if (!PERMISSIONS_PATH) {
    console.error("Permissions path not available");
    return { approved: false, reason: "Permissions path not configured" };
  }

  const requestId = generateRequestId();
  const requestFile = path.join(PERMISSIONS_PATH, `${requestId}.request`);
  const responseFile = path.join(PERMISSIONS_PATH, `${requestId}.response`);

  // Write request file
  const request = {
    id: requestId,
    tool: tool_name,
    input: input,
    timestamp: new Date().toISOString()
  };

  try {
    fs.writeFileSync(requestFile, JSON.stringify(request, null, 2));

    // Poll for response file
    const maxWaitTime = 30000; // 30 seconds timeout
    const pollInterval = 100; // Check every 100ms
    let waitTime = 0;

    while (waitTime < maxWaitTime) {
      if (fs.existsSync(responseFile)) {
        const responseContent = fs.readFileSync(responseFile, 'utf8');
        const response = JSON.parse(responseContent);

        // Clean up response file
        fs.unlinkSync(responseFile);

        return { 
          approved: response.approved, 
          reason: response.approved ? undefined : "User rejected the request" 
        };
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
      waitTime += pollInterval;
    }

    // Timeout - clean up request file and deny
    if (fs.existsSync(requestFile)) {
      fs.unlinkSync(requestFile);
    }

    console.error(`Permission request ${requestId} timed out`);
    return { approved: false, reason: "Permission request timed out" };

  } catch (error) {
    console.error(`Error requesting permission: ${error}`);
    return { approved: false, reason: `Error processing permission request: ${error}` };
  }
}

server.tool(
  "approval_prompt",
  'Request user permission to execute a tool via VS Code dialog',
  {
    tool_name: z.string().describe("The name of the tool requesting permission"),
    input: z.object({}).passthrough().describe("The input for the tool"),
    tool_use_id: z.string().optional().describe("The unique tool use request ID"),
  },
  async ({ tool_name, input }) => {
    console.error(`Requesting permission for tool: ${tool_name}`);

    const permissionResult = await requestPermission(tool_name, input);

    const behavior = permissionResult.approved ? "allow" : "deny";
    console.error(`Permission ${behavior}ed for tool: ${tool_name}`);

    return {
      content: [
        {
          type: "text",
          text: behavior === "allow" ?
            JSON.stringify({
              behavior: behavior,
              updatedInput: input,
            })
            :
            JSON.stringify({
              behavior: behavior,
              message: permissionResult.reason || "Permission denied",
            })
          ,
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Permissions MCP Server running on stdio`);
  console.error(`Using permissions directory: ${PERMISSIONS_PATH}`);
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});