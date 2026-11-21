/**
 * The Agent's model dependency, injected into the Demo Session service.
 *
 * Placeholder: the real shape (Messages API calls for the manual tool loop) and
 * the scripted fake used by tests are defined by the Agent chat ticket (#3).
 */
export interface ModelClient {
  readonly name: string;
}

export const placeholderModelClient: ModelClient = { name: "placeholder" };
