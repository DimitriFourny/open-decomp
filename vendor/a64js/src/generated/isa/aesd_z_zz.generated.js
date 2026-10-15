export const ENCODINGS = [
    {
        "instructionId": "aesd_z_zz",
        "encodingId": "aesd_z_zz_",
        "mnemonic": "AESD",
        "className": "SVE2",
        "fileName": "aesd_z_zz.xml",
        "mask": 4294966272,
        "value": 1159914496,
        "bitCount": 22,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "op",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "o2",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zdn",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE_AES"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE_AES",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-destructive-binary"
    }
];
