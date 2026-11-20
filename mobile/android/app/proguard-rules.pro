# kotlinx.serialization: keep generated serializers for the protocol and provider models.
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class ai.jarvis.mobile.** {
    *** Companion;
}
-keepclasseswithmembers class ai.jarvis.mobile.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-dontwarn org.slf4j.**
