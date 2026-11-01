declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth once the session is verified. */
      analyst?: { id: string };
      requestId?: string;
    }
  }
}
export {};
