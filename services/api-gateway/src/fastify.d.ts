import type { User } from "@carebridge/shared-types";

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
    sessionId?: string;
  }
}
