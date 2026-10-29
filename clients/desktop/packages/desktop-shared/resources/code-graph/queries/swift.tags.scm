; Canopy's bounded Swift coverage. Capture the declaration itself, not its owner.
(class_declaration declaration_kind: ["class" "struct" "actor"] name: (type_identifier) @name) @definition.class
(class_declaration declaration_kind: "enum" name: (type_identifier) @name) @definition.enum
(protocol_declaration name: (type_identifier) @name) @definition.interface
(typealias_declaration name: (type_identifier) @name) @definition.type
(function_declaration name: (simple_identifier) @name) @definition.function
(property_declaration (pattern (simple_identifier) @name)) @definition.constant
(call_expression . (simple_identifier) @name) @reference.call
(call_expression . (navigation_expression (navigation_suffix (simple_identifier) @name))) @reference.call
