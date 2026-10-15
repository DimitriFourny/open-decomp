export const ENCODINGS = [
    {
        "instructionId": "sqrdcmlah_z_zzz",
        "encodingId": "sqrdcmlah_z_zzz_",
        "mnemonic": "SQRDCMLAH",
        "className": "SVE2",
        "fileName": "sqrdcmlah_z_zzz.xml",
        "mask": 4280348672,
        "value": 1140862976,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "op",
                "lsb": 12,
                "width": 1
            },
            {
                "name": "rot",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zda",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE2 || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-complex-vector"
    }
];
