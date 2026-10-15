export const ENCODINGS = [
    {
        "instructionId": "sm4e_z_zz",
        "encodingId": "sm4e_z_zz_",
        "mnemonic": "SM4E",
        "className": "SVE2",
        "fileName": "sm4e_z_zz.xml",
        "mask": 4294966272,
        "value": 1159979008,
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
            "FEAT_SVE_SM4"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE_SM4",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-destructive-binary"
    }
];
