{
  description = "Vencord userplugins";

  outputs = _: {
    plugins = {
      QuickFind = ./QuickFind;
    };
  };
}
