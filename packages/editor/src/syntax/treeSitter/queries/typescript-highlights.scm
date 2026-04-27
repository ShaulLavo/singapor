; Types
; -----

(type_identifier) @type
(predefined_type) @type.builtin

((identifier) @type
 (#match? @type "^[A-Z]"))

(type_arguments
  "<" @punctuation.bracket
  ">" @punctuation.bracket)

; Type annotations (e.g., `: THREE.PerspectiveCamera`)
(type_annotation
  (type_identifier) @type)

(type_annotation
  (nested_type_identifier
    module: (identifier) @namespace
    name: (type_identifier) @type))

; Generic type parameters
(type_parameter
  name: (type_identifier) @type.parameter)

; Type alias declarations (type Foo = ...)
(type_alias_declaration
  "type" @keyword.type
  name: (type_identifier) @type.definition)

; Interface declarations
(interface_declaration
  "interface" @keyword.type
  name: (type_identifier) @type.definition)

; Variables
; ---------

(required_parameter (identifier) @variable.parameter)
(optional_parameter (identifier) @variable.parameter)

; Declaration Keywords (let, const, var, function, class, etc.)
; These should stand out as they define structure

[
  "const"
  "let"
  "var"
  "function"
  "class"
] @keyword.declaration

; Import/Export Keywords
; These are module-level and should be visually grouped
; Note: "type" after "import" is handled specially below

[
  "import"
  "export"
  "from"
  "as"
  "default"
] @keyword.import

; "import type" - the type keyword should match import color
(import_statement
  "type" @keyword.import)

; TypeScript-specific Keywords (excluding type, interface which are handled above)

[
  "abstract"
  "declare"
  "enum"
  "implements"
  "keyof"
  "namespace"
  "private"
  "protected"
  "public"
  "readonly"
  "override"
  "satisfies"
  "infer"
  "extends"
  "typeof"
] @keyword

; Control Flow Keywords

[
  "if"
  "else"
  "switch"
  "case"
  "break"
  "continue"
  "return"
  "throw"
  "try"
  "catch"
  "finally"
  "for"
  "while"
  "do"
  "in"
  "of"
  "await"
  "async"
  "yield"
] @keyword.control
