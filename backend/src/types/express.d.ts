declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth once the session is verified. */
      analyst?: { analystId: string; displayName: string };
      requestId?: string;
    }
  }
}
export {};
