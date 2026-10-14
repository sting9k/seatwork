/** A refusal as a seat reads it: code, sentence, whether to retry, what a right call is. */
export const refusal = (error: { code: string; message: string; retryable: boolean; fix?: unknown }): string =>
  JSON.stringify({
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.fix === undefined ? {} : { fix: error.fix }),
    },
  });
