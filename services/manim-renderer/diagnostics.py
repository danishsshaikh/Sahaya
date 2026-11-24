"""Bounded validation feedback for the app's targeted repair protocol."""

class PlanValidationError(ValueError):
    def __init__(self, issues):
        self.issues = issues[:12]
        first = self.issues[0]
        path = ".".join(map(str, first["path"])) or "plan"
        super().__init__(f"{path}: {first['message']}")


def issue(path, code, message, **limits):
    return {"path": list(path), "code": code, "message": message, **limits}


def schema_issues(error):
    path = list(error.absolute_path)
    rule, expected, value = error.validator, error.validator_value, error.instance
    if rule == "oneOf" and path == ["model"] and isinstance(value, dict):
        models = [option["properties"]["kind"]["const"] for option in expected]
        if value.get("kind") not in models:
            yield issue([*path, "kind"], "enum", "Choose a supported scientific model", allowed=models)
        else:
            selected = models.index(value["kind"])
            for detail in error.context:
                if next(iter(detail.schema_path), None) == selected:
                    yield from schema_issues(detail)
    elif rule == "required":
        for name in expected:
            if name not in value:
                yield issue([*path, name], "required", "This field is required")
    elif rule == "additionalProperties":
        properties = error.schema.get("properties", {})
        for name in value.keys() - properties.keys():
            yield issue([*path, name], "unsupportedField", "Remove this unsupported field")
    elif rule in ("minimum", "maximum"):
        yield issue(path, rule, f"Value must satisfy {rule} {expected}", limit=expected,
                    value=value if isinstance(value, (int, float)) and abs(value) < 1e12 else None)
    elif rule in ("minLength", "maxLength", "minItems", "maxItems"):
        yield issue(path, rule, f"Length must satisfy {rule} {expected}", limit=expected, value=len(value))
    elif rule == "enum":
        yield issue(path, rule, "Choose a supported value", allowed=expected,
                    value=value if isinstance(value, str) and len(value) <= 40 else None)
    elif rule in ("const", "type", "pattern"):
        yield issue(path, rule, f"Expected {rule} {expected}", allowed=expected)
    else:
        yield issue(path, rule, "Value does not satisfy the plan schema")


def require(condition, path, code, message, **limits):
    if not condition:
        raise PlanValidationError([issue(path, code, message, **limits)])
