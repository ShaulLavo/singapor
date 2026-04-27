(interface_declaration) @fold
(type_alias_declaration) @fold
(enum_declaration) @fold
(internal_module) @fold
(module) @fold

; Inherit JS folds
[
  (function_declaration)
  (class_declaration)
  (method_definition)
  (arrow_function)
  (object)
  (import_statement)
] @fold
