import {
  ADMITTED_INTERFACE_TOOL_CATEGORIES,
  CANOPY_INSTRUCTION_DEFINITIONS,
  CORE_CLIENT_TOOL_INSTRUCTION_DEFINITIONS,
  CORE_CLIENT_TOOLS_REGISTER,
  CORE_CLIENT_TOOLS_UNREGISTER,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CoreClientToolDescriptorSchema,
  CoreClientToolsRegisterParamsSchema,
  CoreClientToolsUnregisterParamsSchema,
  INTERFACE_SURFACES,
  INTERFACE_TOOL_CATALOG,
  INTERFACE_TOOL_NAMES,
  interfaceToolDescriptor,
} from '..';

const catalogEntries = Object.values(INTERFACE_TOOL_CATALOG);
const meta = { idempotencyKey: 'key-1' };

describe('interface tool contract (CAN-4131)', () => {
  it('the catalog holds only presentation tools and names the surfaces that serve each', () => {
    expect(Object.keys(INTERFACE_TOOL_CATALOG).sort()).toEqual([
      'ui.app_advisor.present',
      'ui.app_advisor.show_files',
      'ui.get_current_ui_state',
      'ui.show_files',
    ]);
    expect(INTERFACE_TOOL_NAMES).toEqual([
      'ui.app_advisor.present',
      'ui.app_advisor.show_files',
      'ui.get_current_ui_state',
      'ui.show_files',
    ]);
    for (const entry of catalogEntries) {
      expect(ADMITTED_INTERFACE_TOOL_CATEGORIES).toContain(entry.category);
      expect(entry.surfaces.length).toBeGreaterThan(0);
      for (const surface of entry.surfaces)
        expect(INTERFACE_SURFACES).toContain(surface);
      expect(entry.deadlineMs).toBe(30_000);
    }
  });

  it('no catalog tool affects canonical state', () => {
    for (const entry of catalogEntries)
      expect(entry.affectsCanonicalState).toBe(false);
    expect(Object.isFrozen(INTERFACE_TOOL_CATALOG)).toBe(true);
  });

  it('register and unregister params are strict', () => {
    const register = {
      tools: [interfaceToolDescriptor('ui.show_files')],
      _meta: meta,
    };
    expect(
      CoreClientToolsRegisterParamsSchema.safeParse(register).success,
    ).toBe(true);
    for (const extra of [{ leaseId: 'lease-1' }, { surface: 'main' }]) {
      expect(
        CoreClientToolsRegisterParamsSchema.safeParse({ ...register, ...extra })
          .success,
      ).toBe(false);
      expect(
        CoreClientToolsUnregisterParamsSchema.safeParse({ all: true, ...extra })
          .success,
      ).toBe(false);
    }
    expect(
      CoreClientToolsUnregisterParamsSchema.safeParse({ all: true }).success,
    ).toBe(true);
    expect(
      CoreClientToolsUnregisterParamsSchema.safeParse({
        toolNames: ['ui.show_files'],
      }).success,
    ).toBe(true);
    expect(
      CoreClientToolsUnregisterParamsSchema.safeParse({
        toolNames: ['ui.show_files'],
        all: true,
      }).success,
    ).toBe(false);
    expect(CoreClientToolsUnregisterParamsSchema.safeParse({}).success).toBe(
      false,
    );
  });

  it('a native_intent or unknown category is refused and no catalog tool affects canonical state', () => {
    expect(
      CoreClientToolDescriptorSchema.safeParse({
        ...interfaceToolDescriptor('ui.show_files'),
        category: 'domain',
      }).success,
    ).toBe(false);
    expect(ADMITTED_INTERFACE_TOOL_CATEGORIES).not.toContain('native_intent');
    for (const entry of catalogEntries)
      expect(entry.affectsCanonicalState).toBe(false);
  });

  it('the tool definitions stay out of the transport and global registries', () => {
    expect(CORE_CLIENT_TOOLS_REGISTER).toBe('core.client.tools.register');
    expect(CORE_CLIENT_TOOLS_UNREGISTER).toBe('core.client.tools.unregister');
    expect(
      Object.keys(CORE_CLIENT_TOOL_INSTRUCTION_DEFINITIONS).sort(),
    ).toEqual(['core.client.tools.register', 'core.client.tools.unregister']);
    for (const name of [
      'core.client.tools.register',
      'core.client.tools.unregister',
    ]) {
      expect(Object.keys(CORE_TRANSPORT_INSTRUCTION_DEFINITIONS)).not.toContain(
        name,
      );
      expect(Object.keys(CANOPY_INSTRUCTION_DEFINITIONS)).not.toContain(name);
    }
  });

  it('no definition in the relay or the global registries invokes an interface tool', () => {
    const invoke = /^core\.client\.tools?\.(invoke|call)/;
    for (const registry of [
      CANOPY_INSTRUCTION_DEFINITIONS,
      CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
      CORE_CLIENT_TOOL_INSTRUCTION_DEFINITIONS,
    ])
      for (const name of Object.keys(registry))
        expect(name).not.toMatch(invoke);
  });

  it('interfaceToolDescriptor parses with the register schema', () => {
    for (const name of INTERFACE_TOOL_NAMES)
      expect(
        CoreClientToolsRegisterParamsSchema.safeParse({
          tools: [interfaceToolDescriptor(name)],
          _meta: meta,
        }).success,
      ).toBe(true);
  });
});
