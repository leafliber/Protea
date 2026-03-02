import 'package:flutter/material.dart';

void main() {
  runApp(const ProteaApp());
}

class ProteaApp extends StatelessWidget {
  const ProteaApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Protea',
      theme: ThemeData(
        primarySwatch: Colors.blue,
      ),
      home: const Scaffold(
        body: Center(
          child: Text('Protea - AI Productivity'),
        ),
      ),
    );
  }
}
