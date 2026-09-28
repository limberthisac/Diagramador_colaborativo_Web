from django.db import models

# Create your models here.
class BackupUML(models.Model):
    room_id = models.UUIDField(unique=True)   # guarda tu id tipo UUID
    data = models.JSONField() 
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return str(self.room_id)